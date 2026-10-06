/**
 * 轮询微信绑定结果
 * POST /api/wx-bind-poll
 * Body: { scene: "b_..." }
 * 响应统一带 Cache-Control: no-store
 */
import { requireAuth } from '../lib/auth-token.js';
import { pickKvBinding } from '../lib/kv-binding.js';
import { pickWxScanD1, getWxScan, deleteWxScan } from '../lib/wx-scan-d1.js';
import { readKvUser, writeKvUser, decryptKvInner } from '../lib/kv-secure.js';
import { readWxuIndex, writeWxuIndex, deleteWxuIndex } from '../lib/wx-index.js';

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    }
  });
}

export async function onRequest(context) {
  const { request, env } = context;
  
  if (request.method !== 'POST') {
    return json({ success: false, error: 'method_not_allowed' }, 405);
  }
  
  // 认证检查
  const auth = await requireAuth(context);
  if (!auth) {
    return json({ success: false, code: 'AUTH_REQUIRED' }, 401);
  }
  
  const kv = pickKvBinding(env);
  if (!kv) {
    return json({ success: false, error: 'kv_unavailable' }, 503);
  }
  
  try {
    const body = await request.json();
    const scene = body.scene;
    
    // scene 格式校验
    if (!scene || typeof scene !== 'string' || !/^b_[0-9a-f]{24}$/.test(scene)) {
      return json({ success: false, error: 'invalid_scene' }, 400);
    }
    
    const confirm = body.confirm === true;
    const me = auth.phone;
    const bindKey = `wxbind:${scene}`;
    const scanKey = `wxscan:${scene}`;
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
          if (row.phone !== me) {
            return json({ success: false, code: 'FORBIDDEN' }, 403);
          }
          if (row.wxu) {
            openid = row.wxu;
          } else {
            const scanEnc = await kv.get(scanKey);
            let scanData = null;
            try { scanData = scanEnc ? JSON.parse(scanEnc) : null; } catch { scanData = null; }
            if (!scanData || typeof scanData.openid !== 'string' || !scanData.openid) {
              return json({ status: 'waiting' });
            }
            openid = scanData.openid;
          }
        }
      }
    } catch (d1Err) {
      console.warn('wx-bind-poll d1 read failed, fallback to kv:', d1Err);
      d1 = null;
    }
    
    if (!openid) {
      // 读取绑定记录
      const bindEnc = await kv.get(bindKey);
      if (!bindEnc) {
        return json({ status: 'expired' });
      }
      
      let bindData;
      try {
        const inner = await decryptKvInner(env, bindEnc);
        if (!inner || typeof inner !== 'object') {
          return json({ status: 'expired' });
        }
        bindData = inner;
      } catch {
        return json({ status: 'expired' });
      }
      
      if (bindData.phone !== me) {
        return json({ success: false, code: 'FORBIDDEN' }, 403);
      }
      
      // 检查扫码事件
      const scanEnc = await kv.get(scanKey);
      if (!scanEnc) {
        return json({ status: 'waiting' });
      }
      
      let scanData;
      try {
        scanData = JSON.parse(scanEnc);
      } catch {
        // 格式错误当作未扫码
        return json({ status: 'waiting' });
      }
      
      openid = scanData.openid;
      if (!openid || typeof openid !== 'string') {
        return json({ status: 'waiting' });
      }
    }
    
    // 拿到 openid 后，非确认请求只返回 scanned
    if (!confirm) {
      return json({ status: 'scanned' });
    }
    
    // 查重
    let existing = null;
    try {
      existing = await readWxuIndex(kv, env, openid);
    } catch (e) {
      console.error('readWxuIndex failed:', e);
      return json({ success: false, error: 'internal_error' }, 500);
    }
    
    if (existing && existing.phone !== me) {
      // 检查对方主记录是否真的绑定了这个 openid
      try {
        const otherRow = await readKvUser(kv, env, 'phone:' + existing.phone);
        if (otherRow && otherRow.value && otherRow.value.wxu === openid) {
          // 真实冲突
          return json({ status: 'conflict' });
        }
        // 残留索引，继续绑定（覆盖）
      } catch (e) {
        console.error('read other user failed:', e);
        return json({ success: false, error: 'internal_error' }, 500);
      }
    }
    
    const createdIndex = !existing || existing.phone !== me;
    
    // 写新索引
    try {
      await writeWxuIndex(kv, env, openid, me, 'mp_openid');
    } catch (e) {
      console.error('writeWxuIndex failed:', e);
      return json({ success: false, error: 'internal_error' }, 500);
    }
    
    // 读主记录
    const phoneKey = 'phone:' + me;
    let prev;
    try {
      prev = await readKvUser(kv, env, phoneKey);
    } catch (e) {
      console.error('readKvUser failed:', e);
      // 索引已写，需要回滚
      if (createdIndex) {
        try {
          await deleteWxuIndex(kv, env, openid);
        } catch (rollbackErr) {
          console.warn('rollback deleteWxuIndex failed:', rollbackErr);
        }
      }
      return json({ success: false, error: 'internal_error' }, 500);
    }
    
    if (!prev) {
      if (createdIndex) {
        try {
          await deleteWxuIndex(kv, env, openid);
        } catch (rollbackErr) {
          console.warn('rollback deleteWxuIndex failed:', rollbackErr);
        }
      }
      return json({ success: false, error: 'user_not_found' }, 404);
    }
    
    // 准备更新主记录
    const valueMerged = Object.assign({}, prev.value || {}, {
      wxu: openid,
      wxu_type: 'mp_openid'
    });
    
    const oldWxu = prev.value && prev.value.wxu;

    // 写主记录
    try {
      await writeKvUser(kv, env, phoneKey, valueMerged, prev.metadata || {});
    } catch (e) {
      console.error('writeKvUser failed:', e);
      // 主记录写入失败，回滚新索引
      if (createdIndex) {
        try {
          await deleteWxuIndex(kv, env, openid);
        } catch (rollbackErr) {
          console.warn('rollback deleteWxuIndex failed:', rollbackErr);
        }
      }
      return json({ success: false, error: 'internal_error' }, 500);
    }

    // 换绑：主记录已指向新 openid 后才删旧索引，失败只留可自愈的残留
    if (oldWxu && oldWxu !== openid && typeof oldWxu === 'string') {
      try {
        await deleteWxuIndex(kv, env, oldWxu);
      } catch (e) {
        console.warn('delete old wxu index failed:', e);
      }
    }
    
    // 清理临时键
    try {
      await Promise.all([
        kv.delete(bindKey),
        kv.delete(scanKey),
        d1 ? deleteWxScan(d1, scene).catch(() => {}) : Promise.resolve()
      ]);
    } catch (e) {
      console.warn('cleanup temp keys failed:', e);
    }
    
    return json({
      status: 'bound',
      wxu_prefix: openid.slice(0, 8),
      wxu_type: 'mp_openid'
    });
    
  } catch (error) {
    console.error('wx-bind-poll error:', error);
    return json({ success: false, error: 'internal_error' }, 500);
  }
}
