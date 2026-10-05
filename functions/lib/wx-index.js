/**
 * 微信用户索引操作
 */
import { hmacHex, encryptKvInner, decryptKvInner, requireOpaqueWriteSecrets } from './kv-secure.js';

const WXU_PREFIX = 'wxu:';

/**
 * 计算微信用户索引的存储键
 * @param {any} env
 * @param {string} wxu 微信用户标识（openid 或 unionid）
 * @returns {Promise<string>}
 */
export async function wxuIndexKey(env, wxu) {
  const mac = await hmacHex(env, WXU_PREFIX + wxu);
  return WXU_PREFIX + mac;
}

/**
 * 读取微信用户索引
 * @param {any} kv
 * @param {any} env
 * @param {string} wxu
 * @returns {Promise<{phone: string, wxu_type: string} | null>}
 */
export async function readWxuIndex(kv, env, wxu) {
  const storageKey = await wxuIndexKey(env, wxu);
  const encrypted = await kv.get(storageKey);
  if (encrypted === null || encrypted === undefined) return null;
  
  let inner;
  try {
    inner = await decryptKvInner(env, encrypted);
  } catch (e) {
    throw new Error('Invalid wxu index inner: ' + (e.message || String(e)));
  }
  
  if (!inner || typeof inner !== 'object' ||
      typeof inner.phone !== 'string' || !/^\d{6,20}$/.test(inner.phone) ||
      (inner.wxu_type !== 'mp_openid' && inner.wxu_type !== 'unionid'))
    throw new Error('Invalid wxu index fields');
  return { phone: inner.phone, wxu_type: inner.wxu_type };
}

/**
 * 写入微信用户索引
 * @param {any} kv
 * @param {any} env
 * @param {string} wxu
 * @param {string} phone
 * @param {string} wxu_type
 * @returns {Promise<void>}
 */
export async function writeWxuIndex(kv, env, wxu, phone, wxu_type) {
  requireOpaqueWriteSecrets(env);
  
  const storageKey = await wxuIndexKey(env, wxu);
  const inner = {
    phone,
    wxu_type,
    savedAt: Date.now(),
  };
  
  const encrypted = await encryptKvInner(env, inner);
  await kv.put(storageKey, encrypted);
}

/**
 * 删除微信用户索引
 * @param {any} kv
 * @param {any} env
 * @param {string} wxu
 * @returns {Promise<void>}
 */
export async function deleteWxuIndex(kv, env, wxu) {
  try {
    const storageKey = await wxuIndexKey(env, wxu);
    await kv.delete(storageKey);
  } catch (e) {
    console.warn('deleteWxuIndex failed:', e);
  }
}
