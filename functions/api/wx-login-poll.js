/**
 * 轮询微信扫码登录结果
 */
import { pickKvBinding } from '../lib/kv-binding.js';
import { readKvUser, decryptKvInner } from '../lib/kv-secure.js';
import { readWxuIndex } from '../lib/wx-index.js';
import { issueAuthToken, buildAuthCookie } from '../lib/auth-token.js';
import { pickWxScanD1, getWxScan, deleteWxScan } from '../lib/wx-scan-d1.js';

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    }
  });
}

/**
 * 十六进制字符串转 Uint8Array
 */
function hexToBytes(hex) {
  if (typeof hex !== "string" || hex.length % 2 !== 0) return null;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    const byte = parseInt(hex.slice(i, i + 2), 16);
    if (isNaN(byte)) return null;
    bytes[i / 2] = byte;
  }
  return bytes;
}

/**
 * Uint8Array 转十六进制字符串
 */
function bytesToHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * 常量时间比较两个十六进制字符串
 */
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export async function onRequest(context) {
  const { request, env } = context;
  
  if (request.method !== 'POST') {
    return json({ success: false, error: 'method_not_allowed' }, 405);
  }
  
  const kv = pickKvBinding(env);
  if (!kv) {
    return json({ success: false, error: 'kv_unavailable' }, 503);
  }
  
  try {
    // 解析 body，失败或 null 时 scene 为空字符串
    const body = await request.json().catch(() => null);
    const scene = body && typeof body.scene === 'string' ? body.scene : '';
    
    // scene 格式校验
    if (!/^l_[0-9a-f]{24}$/.test(scene)) {
      return json({ success: false, error: 'invalid_scene' }, 400);
    }
    
    // 从 Cookie 读取 nonce
    const cookieHeader = request.headers.get('Cookie') || '';
    const match = cookieHeader.match(/(?:^|;\s*)hz_wxl=([0-9a-f]{64})(?:;|$)/);
    const cookieNonce = match ? match[1] : '';
    if (!/^[0-9a-f]{64}$/.test(cookieNonce)) {
      return json({ success: false, error: 'invalid_session' }, 403);
    }
    
    // 读取登录记录
    const loginKey = `wxlogin:${scene}`;
    const loginEnc = await kv.get(loginKey);
    if (!loginEnc) {
      return json({ status: 'expired' });
    }
    
    let loginData;
    try {
      const inner = await decryptKvInner(env, loginEnc);
      if (!inner || typeof inner !== 'object' || !inner.nh) {
        return json({ status: 'expired' });
      }
      loginData = inner;
    } catch {
      return json({ status: 'expired' });
    }
    
    // 验证 nonce hash
    const nonceBytes = hexToBytes(cookieNonce);
    if (!nonceBytes) {
      return json({ success: false, error: 'invalid_session' }, 403);
    }
    
    const hashBuffer = await crypto.subtle.digest("SHA-256", nonceBytes);
    const nh = bytesToHex(new Uint8Array(hashBuffer));
    if (!safeEqual(nh, loginData.nh)) {
      return json({ success: false, error: 'invalid_session' }, 403);
    }
    
    // 获取 openid
    let openid = null;
    let d1 = null;
    
    // D1 优先分支
    try {
      d1 = pickWxScanD1(env);
      if (d1) {
        const row = await getWxScan(d1, scene, Date.now());
        if (row) {
          if (row.expired) {
            return json({ status: 'expired' });
          }
          if (row.wxu) {
            openid = row.wxu;
          }
        }
      }
    } catch (d1Err) {
      console.warn('wx-login-poll d1 read failed, fallback to kv:', d1Err.message);
      d1 = null;
    }
    
    if (!openid) {
      // 读取扫码事件
      const scanEnc = await kv.get(`wxscan:${scene}`);
      if (!scanEnc) {
        return json({ status: 'waiting' });
      }
      
      let scanData;
      try {
        scanData = JSON.parse(scanEnc);
      } catch {
        return json({ status: 'waiting' });
      }
      
      openid = scanData.openid;
      if (!openid || typeof openid !== 'string') {
        return json({ status: 'waiting' });
      }
    }
    
    // 读取微信索引
    let idx;
    try {
      idx = await readWxuIndex(kv, env, openid);
    } catch (e) {
      console.error('readWxuIndex failed:', e.message);
      return json({ success: false, error: 'internal_error' }, 500);
    }
    
    if (!idx) {
      return json({ status: 'unknown' });
    }
    
    // 读取用户主记录
    const phoneKey = 'phone:' + idx.phone;
    let row;
    try {
      row = await readKvUser(kv, env, phoneKey);
    } catch (e) {
      console.error('readKvUser failed:', e.message);
      return json({ success: false, error: 'internal_error' }, 500);
    }
    
    if (!row || !row.value || row.value.wxu !== openid) {
      return json({ status: 'unknown' });
    }
    
    const value = row.value || {};
    const meta = row.metadata || {};
    
    // 用户状态检查
    let userStatus = parseInt(meta.status, 10);
    if (isNaN(userStatus)) userStatus = null;
    if (userStatus === 3) {
      return json({ status: 'deleted' });
    }
    
    // 超管检查（与 auth-claim-scan.js 完全相同）
    const typeRaw = String(
      meta.type != null && String(meta.type) !== "" ? meta.type : meta.uA != null ? meta.uA : ""
    ).trim();
    let typeMask = 0;
    if (/^[01]+$/.test(typeRaw)) {
      typeMask = parseInt(typeRaw, 2) || 0;
    } else {
      typeMask = parseInt(typeRaw, 10) || 0;
    }
    const isSuperuser = (typeMask & 1) !== 0;
    if (isSuperuser) {
      return json({ status: 'password_required' });
    }
    
    // 删除登录记录（成功后）
    try {
      await kv.delete(loginKey);
    } catch (e) {
      console.error('kv.delete login record failed:', e.message);
      return json({ success: false, error: 'internal_error' }, 500);
    }
    
    // 签发令牌
    let token, exp;
    try {
      const tv = Number(value.tv || 0);
      const issued = await issueAuthToken(env, idx.phone, { tv });
      token = issued.token;
      exp = issued.exp;
    } catch (tokenErr) {
      console.error('issueAuthToken failed:', tokenErr.message);
      return json({ success: false, error: 'token_error' }, 500);
    }
    
    // 清理临时键（吞错）
    try {
      await Promise.all([
        kv.delete(`wxscan:${scene}`),
        d1 ? deleteWxScan(d1, scene).catch(() => {}) : Promise.resolve()
      ]);
    } catch (e) {
      console.warn('cleanup temp keys failed:', e.message);
    }
    
    // 构建响应
    const avatar_url = value.avatar_url != null ? String(value.avatar_url) : "";
    const avatar_r2_key = value.avatar_r2_key != null ? String(value.avatar_r2_key) : "";
    const avatar_data_url = value.avatar_data_url != null ? String(value.avatar_data_url) : "";
    
    const response = json({
      status: 'ok',
      phone: idx.phone,
      stored_username: value.name != null ? String(value.name) : '',
      stored_email: value.email != null ? String(value.email) : '',
      user_status: userStatus,
      is_superuser: false,
      user_data: {
        other_data: value.uuid != null ? String(value.uuid) : '',
        pwd: '',
        avatar_url,
        avatar_r2_key,
        avatar_data_url,
        type: typeMask,
        group: value.group != null ? String(value.group) : '',
        g_role: Number(value.g_role) === 1 ? 1 : 0
      },
      auth: { exp }
    });
    
    // 设置两个 Cookie
    response.headers.append('Set-Cookie', buildAuthCookie(token, 2592000));
    response.headers.append('Set-Cookie',
      'hz_wxl=; Path=/api/wx-login-poll; Max-Age=0; HttpOnly; Secure; SameSite=Lax'
    );
    
    return response;
    
  } catch (error) {
    console.error('wx-login-poll error:', error.message);
    return json({ success: false, error: 'internal_error' }, 500);
  }
}
