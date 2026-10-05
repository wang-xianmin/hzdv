/**
 * 获取当前认证状态：GET /api/auth-whoami
 * 返回 { logged_in: true, phone, exp } 或 { logged_in: false }
 */
import { requireAuth } from '../lib/auth-token.js';

export async function onRequest(context) {
  const { request } = context;
  
  if (request.method !== 'GET') {
    return new Response(JSON.stringify({ error: 'Method Not Allowed' }), {
      status: 405,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    });
  }
  
  const auth = await requireAuth(context);
  
  if (auth) {
    return new Response(JSON.stringify({
      logged_in: true,
      phone: auth.phone,
      exp: auth.exp,
    }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    });
  }
  
  return new Response(JSON.stringify({
    logged_in: false,
  }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}
