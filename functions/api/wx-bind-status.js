/**
 * 获取微信绑定状态
 */
import { requireAuth } from '../lib/auth-token.js';
import { pickKvBinding } from '../lib/kv-binding.js';
import { readKvUser } from '../lib/kv-secure.js';

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
  
  if (request.method !== 'GET') {
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
    const row = await readKvUser(kv, env, 'phone:' + auth.phone);
    
    if (!row || !row.value || !row.value.wxu) {
      return json({
        success: true,
        bound: false,
        wxu_prefix: null,
        wxu_type: null
      });
    }
    
    const { wxu, wxu_type } = row.value;
    const wxu_prefix = wxu && wxu.length >= 8 ? wxu.slice(0, 8) : null;
    
    return json({
      success: true,
      bound: true,
      wxu_prefix,
      wxu_type: wxu_type || null
    });
    
  } catch (error) {
    console.error('wx-bind-status error:', error);
    return json({ success: false, error: 'internal_error' }, 500);
  }
}
