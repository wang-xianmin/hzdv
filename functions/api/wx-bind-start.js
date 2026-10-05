/**
 * 启动微信绑定流程
 */
import { requireAuth } from '../lib/auth-token.js';
import { pickKvBinding } from '../lib/kv-binding.js';
import { encryptKvInner, requireOpaqueWriteSecrets } from '../lib/kv-secure.js';
import { createTempQr } from '../lib/wx-mp.js';

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
  
  // 检查用户状态
  const status = parseInt(auth.metadata.status || '0');
  if (status === 3) {
    return json({ success: false, code: 'USER_DELETED' }, 403);
  }
  
  const kv = pickKvBinding(env);
  if (!kv) {
    return json({ success: false, error: 'kv_unavailable' }, 503);
  }
  
  try {
    // 生成场景值
    const randomBytes = new Uint8Array(12);
    crypto.getRandomValues(randomBytes);
    const scene = 'b_' + Array.from(randomBytes)
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
    
    // 创建绑定记录
    requireOpaqueWriteSecrets(env);
    const bindValue = await encryptKvInner(env, {
      phone: auth.phone,
      at: Date.now()
    });
    
    await kv.put(`wxbind:${scene}`, bindValue, { expirationTtl: 300 });
    
    // 创建二维码
    const qrResult = await createTempQr(env, kv, scene, 300);
    
    return json({
      success: true,
      scene,
      qr_url: qrResult.qr_url,
      expire_seconds: qrResult.expire_seconds
    });
    
  } catch (error) {
    console.error('wx-bind-start error:', error);
    
    if (error.message.includes('WeChat API')) {
      return json({ success: false, error: 'wx_qr_failed' }, 502);
    }
    
    return json({ success: false, error: 'internal_error' }, 500);
  }
}
