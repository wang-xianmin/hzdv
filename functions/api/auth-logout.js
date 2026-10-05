/**
 * 登出：POST /api/auth-logout
 * 清除认证 Cookie
 */
import { buildClearAuthCookie } from '../lib/auth-token.js';

export async function onRequest(context) {
  const { request } = context;
  
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method Not Allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
  }
  
  return new Response(JSON.stringify({ success: true }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Set-Cookie': buildClearAuthCookie(),
    },
  });
}
