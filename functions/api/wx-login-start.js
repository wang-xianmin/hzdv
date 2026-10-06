/**
 * 启动微信扫码登录流程
 */
import { pickKvBinding } from '../lib/kv-binding.js';
import { encryptKvInner, requireOpaqueWriteSecrets } from '../lib/kv-secure.js';
import { createTempQr } from '../lib/wx-mp.js';
import { pickWxScanD1, createWxScan } from '../lib/wx-scan-d1.js';

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
    // 生成场景值
    const randomBytes = new Uint8Array(12);
    crypto.getRandomValues(randomBytes);
    const scene = 'l_' + Array.from(randomBytes)
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
    
    // 生成 nonce
    const nonceBytes = new Uint8Array(32);
    crypto.getRandomValues(nonceBytes);
    const nonce = bytesToHex(nonceBytes);
    
    // 计算 nh = SHA-256(nonce)
    const hashBuffer = await crypto.subtle.digest("SHA-256", nonceBytes);
    const nh = bytesToHex(new Uint8Array(hashBuffer));
    
    // 创建登录记录
    requireOpaqueWriteSecrets(env);
    const loginValue = await encryptKvInner(env, {
      nh,
      at: Date.now()
    });
    
    await kv.put(`wxlogin:${scene}`, loginValue, { expirationTtl: 300 });
    
    // D1 写入（失败仅警告）
    const d1 = pickWxScanD1(env);
    if (d1) {
      try {
        await createWxScan(d1, { scene, phone: '', now: Date.now() });
      } catch (err) {
        console.warn('wx-login-start d1 insert failed:', err);
      }
    }
    
    // 创建二维码
    const qrResult = await createTempQr(env, kv, scene, 300);
    
    // 响应
    const response = json({
      success: true,
      scene,
      qr_url: qrResult.qr_url,
      expire_seconds: qrResult.expire_seconds
    });
    
    // 设置 Cookie: hz_wxl
    response.headers.append('Set-Cookie', 
      `hz_wxl=${nonce}; Path=/api/wx-login-poll; Max-Age=300; HttpOnly; Secure; SameSite=Lax`
    );
    
    return response;
    
  } catch (error) {
    console.error('wx-login-start error:', error.message);
    
    if (error.message.includes('WeChat API')) {
      return json({ success: false, error: 'wx_qr_failed' }, 502);
    }
    
    return json({ success: false, error: 'internal_error' }, 500);
  }
}
