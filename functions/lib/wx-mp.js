/**
 * 微信公众号 API 封装
 */
import { encryptKvInner, decryptKvInner } from './kv-secure.js';

const QR_STR_SCENE = 'QR_STR_SCENE';
const ACCESS_TOKEN_KEY = 'wxat:mp';

/**
 * 获取微信公众号 access_token
 * @param {any} env
 * @param {any} kv
 * @returns {Promise<string>}
 */
export async function getMpAccessToken(env, kv) {
  // 尝试从缓存读取
  try {
    const cached = await kv.get(ACCESS_TOKEN_KEY);
    if (cached) {
      const inner = await decryptKvInner(env, cached);
      if (inner && inner.access_token && inner.expires_at > Date.now()) {
        return inner.access_token;
      }
    }
  } catch (e) {
    console.warn('getMpAccessToken cache read failed:', e);
  }
  
  // 从微信 API 获取
  const appid = env.WX_MP_APPID;
  const secret = env.WX_MP_APPSECRET;
  
  if (!appid || !secret) {
    throw new Error('WX_MP_APPID or WX_MP_APPSECRET missing');
  }
  
  const url = `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${encodeURIComponent(appid)}&secret=${encodeURIComponent(secret)}`;
  
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`WeChat API HTTP ${response.status}`);
  }
  
  const data = await response.json();
  if (data.errcode && data.errcode !== 0) {
    // 删除失效的缓存
    await kv.delete(ACCESS_TOKEN_KEY).catch(() => {});
    throw new Error(`WeChat API error ${data.errcode}: ${data.errmsg}`);
  }
  
  const { access_token, expires_in } = data;
  if (!access_token || !expires_in) {
    throw new Error('Invalid WeChat API response');
  }
  
  // 计算过期时间（提前5分钟过期）
  const expiresAt = Date.now() + (expires_in - 300) * 1000;
  const minExpiresAt = Date.now() + 60 * 1000; // 至少1分钟
  const finalExpiresAt = Math.max(expiresAt, minExpiresAt);
  
  // 加密存储
  const inner = { access_token, expires_at: finalExpiresAt };
  const encrypted = await encryptKvInner(env, inner);
  const ttl = Math.max(Math.floor((finalExpiresAt - Date.now()) / 1000), 60);
  
  await kv.put(ACCESS_TOKEN_KEY, encrypted, { expirationTtl: ttl });
  
  return access_token;
}

/**
 * 创建临时二维码
 * @param {any} env
 * @param {any} kv
 * @param {string} sceneStr 场景值字符串
 * @param {number} expireSeconds 过期时间（秒）
 * @returns {Promise<{ticket: string, expire_seconds: number, qr_url: string}>}
 */
export async function createTempQr(env, kv, sceneStr, expireSeconds) {
  const maxRetry = 2;
  
  for (let attempt = 0; attempt < maxRetry; attempt++) {
    try {
      const accessToken = await getMpAccessToken(env, kv);
      const url = `https://api.weixin.qq.com/cgi-bin/qrcode/create?access_token=${encodeURIComponent(accessToken)}`;
      
      const body = {
        expire_seconds: expireSeconds,
        action_name: QR_STR_SCENE,
        action_info: {
          scene: { scene_str: sceneStr }
        }
      };
      
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      
      if (!response.ok) {
        throw new Error(`WeChat API HTTP ${response.status}`);
      }
      
      const data = await response.json();
      
      // 检查 token 是否失效
      if (data.errcode === 40001 || data.errcode === 42001) {
        // 删除缓存并重试
        await kv.delete(ACCESS_TOKEN_KEY).catch(() => {});
        if (attempt === maxRetry - 1) {
          throw new Error(`WeChat API error ${data.errcode}: ${data.errmsg}`);
        }
        continue;
      }
      
      if (data.errcode && data.errcode !== 0) {
        throw new Error(`WeChat API error ${data.errcode}: ${data.errmsg}`);
      }
      
      const { ticket, expire_seconds } = data;
      if (!ticket) {
        throw new Error('Invalid QR response');
      }
      
      return {
        ticket,
        expire_seconds: expire_seconds || expireSeconds,
        qr_url: `https://mp.weixin.qq.com/cgi-bin/showqrcode?ticket=${encodeURIComponent(ticket)}`
      };
    } catch (e) {
      if (attempt === maxRetry - 1) {
        throw e;
      }
    }
  }
  
  throw new Error('Failed to create QR code after retries');
}
