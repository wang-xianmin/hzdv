/**
 * 组索引维护（方案 A）：
 * 主记录逻辑键仍是 phone:xxxx；索引为 gix:{bucket}:{entry}
 *   bucket = HMAC(HMAC_SECRET, "group-bucket:"+group)
 *   entry  = HMAC(HMAC_SECRET, "group-entry:"+group+":"+role+":"+phone)
 * value AES 加密（禁明文 phone）；双读兼容旧 group:{g}:{l|m}:{phone}
 */

import {
  encryptKvInner,
  decryptKvInner,
  encryptionEnabled,
  hmacEnabled,
  hmacHex,
  listKvUserStorageKeys,
  phoneToStorageKey,
  readKvUser,
  readKvUserByStorageKey,
  requireOpaqueWriteSecrets,
} from './kv-secure.js';

export const GIX_PREFIX = 'gix:';
export const LEGACY_GROUP_PREFIX = 'group:';

export function normalizeGroup(groupVal) {
  const g = String(groupVal == null ? '' : groupVal).trim();
  return g;
}

function normalizeRoleTag(gRoleVal) {
  const n = Number(gRoleVal);
  return n === 1 ? 'l' : 'm';
}

/** @deprecated 旧明文索引键；仅双读 / 清理用 */
export function buildGroupIndexKey(group, roleTag, phone) {
  return `group:${group}:${roleTag}:${phone}`;
}

export async function buildGroupIndexBucket(env, group) {
  const g = normalizeGroup(group);
  if (!g) throw new Error('Invalid group for index bucket');
  return hmacHex(env, 'group-bucket:' + g);
}

export async function buildGroupIndexEntry(env, group, roleTag, phone) {
  const g = normalizeGroup(group);
  const role = roleTag === 'l' ? 'l' : 'm';
  const p = String(phone || '');
  if (!g || !p) throw new Error('Invalid group/phone for index entry');
  return hmacHex(env, 'group-entry:' + g + ':' + role + ':' + p);
}

export async function buildOpaqueGroupIndexKey(env, group, roleTag, phone) {
  const bucket = await buildGroupIndexBucket(env, group);
  const entry = await buildGroupIndexEntry(env, group, roleTag, phone);
  return GIX_PREFIX + bucket + ':' + entry;
}

export function getPhoneFromPhoneKey(phoneKey) {
  const s = String(phoneKey || '');
  if (!s.startsWith('phone:')) return '';
  return s.slice('phone:'.length);
}

export function getIndexInfoFromValue(valueObj) {
  const v = valueObj && typeof valueObj === 'object' ? valueObj : {};
  const group = normalizeGroup(v.group);
  const roleTag = normalizeRoleTag(v.g_role);
  return { group, roleTag };
}

async function putEncryptedIndexValue(kv, env, indexKey, payloadObj) {
  requireOpaqueWriteSecrets(env);
  const enc = await encryptKvInner(env, { v: 1, ...payloadObj });
  await kv.put(indexKey, enc);
}

async function readIndexPayload(kv, env, indexKey) {
  const raw = await kv.get(indexKey);
  if (raw == null || typeof raw !== 'string') return null;
  if (encryptionEnabled(env) && raw.startsWith('e1.')) {
    try {
      return await decryptKvInner(env, raw);
    } catch {
      return null;
    }
  }
  try {
    const o = JSON.parse(raw);
    return o && typeof o === 'object' ? o : null;
  } catch {
    return null;
  }
}

export async function removeUserGroupIndexes(kv, env, group, phone) {
  if (!kv || !group || !phone) return 0;
  const keys = [
    buildGroupIndexKey(group, 'l', phone),
    buildGroupIndexKey(group, 'm', phone),
  ];
  if (hmacEnabled(env)) {
    try {
      keys.push(await buildOpaqueGroupIndexKey(env, group, 'l', phone));
      keys.push(await buildOpaqueGroupIndexKey(env, group, 'm', phone));
    } catch {
      /* secrets missing：仍清旧键 */
    }
  }
  await Promise.all(keys.map((k) => kv.delete(k)));
  return keys.length;
}

export async function upsertUserGroupIndex(kv, env, phone, valueObj) {
  const { group, roleTag } = getIndexInfoFromValue(valueObj);
  if (!kv || !group || !phone) return 0;
  requireOpaqueWriteSecrets(env);
  await removeUserGroupIndexes(kv, env, group, phone);
  const key = await buildOpaqueGroupIndexKey(env, group, roleTag, phone);
  const logicalKey = 'phone:' + phone;
  const uk = await phoneToStorageKey(env, logicalKey);
  await putEncryptedIndexValue(kv, env, key, {
    phone,
    logicalKey,
    uk,
    group,
    role: roleTag,
    updated_at: Date.now(),
  });
  return 1;
}

export async function syncUserGroupIndexOnUpdate(kv, env, phone, prevValue, nextValue) {
  const prev = getIndexInfoFromValue(prevValue || {});
  const next = getIndexInfoFromValue(nextValue || {});
  let deleted = 0;
  let added = 0;
  if (prev.group) {
    deleted += await removeUserGroupIndexes(kv, env, prev.group, phone);
  }
  if (next.group) {
    added += await upsertUserGroupIndex(kv, env, phone, nextValue || {});
  }
  return { deleted, added };
}

async function clearKeysByPrefix(kv, prefix) {
  let deleted = 0;
  let cursor;
  do {
    const page = await kv.list({ prefix, limit: 1000, cursor });
    const keys = (page && page.keys) || [];
    if (keys.length) {
      await Promise.all(
        keys
          .filter((k) => k && k.name)
          .map((k) => {
            deleted++;
            return kv.delete(k.name);
          })
      );
    }
    cursor = page && !page.list_complete ? page.cursor : undefined;
  } while (cursor);
  return deleted;
}

/** 删除某一组号下所有索引键（新旧格式），不影响其它组。 */
export async function clearGroupIndexForGroup(kv, env, group) {
  const g = normalizeGroup(group);
  if (!kv || !g) return 0;
  let deleted = await clearKeysByPrefix(kv, `group:${g}:`);
  if (hmacEnabled(env)) {
    try {
      const bucket = await buildGroupIndexBucket(env, g);
      deleted += await clearKeysByPrefix(kv, GIX_PREFIX + bucket + ':');
    } catch {
      /* ignore */
    }
  }
  return deleted;
}

export async function clearAllGroupIndexes(kv) {
  let deleted = await clearKeysByPrefix(kv, LEGACY_GROUP_PREFIX);
  deleted += await clearKeysByPrefix(kv, GIX_PREFIX);
  return deleted;
}

export async function rebuildAllGroupIndexes(kv, env) {
  const deleted_before = await clearAllGroupIndexes(kv);
  const storageKeys = await listKvUserStorageKeys(kv);

  let total_users = 0;
  let indexed = 0;
  let skipped = 0;
  const errors = [];
  for (const sk of storageKeys) {
    total_users++;
    try {
      const row = await readKvUserByStorageKey(kv, env, sk);
      if (!row || !row.value) {
        skipped++;
        continue;
      }
      const logicalKey = row.logicalKey || (sk.startsWith('phone:') ? sk : '');
      const phone = getPhoneFromPhoneKey(logicalKey);
      if (!phone) {
        skipped++;
        continue;
      }
      indexed += await upsertUserGroupIndex(kv, env, phone, row.value);
    } catch (e) {
      skipped++;
      errors.push({ key: sk, error: String(e && (e.message || e)) });
    }
  }

  return { deleted_before, total_users, indexed, skipped, errors };
}

/** 从全部用户记录中收集合法、去重后的组号（与邀请码组号规则一致） */
export async function collectDistinctGroupIdsFromKvUsers(kv, env) {
  if (!kv) return [];
  function groupIdOk(g) {
    const s = normalizeGroup(g);
    if (!s || s.length > 24) return "";
    if (!/^[\dA-Za-z._-]+$/.test(s)) return "";
    return s;
  }
  const storageKeys = await listKvUserStorageKeys(kv);

  const set = new Set();
  for (const sk of storageKeys) {
    try {
      const row = await readKvUserByStorageKey(kv, env, sk);
      if (!row || !row.value) continue;
      const g = groupIdOk(row.value.group);
      if (g) set.add(g);
    } catch {
      /* skip */
    }
  }
  return Array.from(set).sort();
}

/**
 * 仅重建某一组的索引：先删该组新旧索引，再扫描全部用户，只对组号匹配的用户写入 gix。
 */
export async function rebuildGroupIndexesForGroup(kv, env, group) {
  const g = normalizeGroup(group);
  if (!kv || !g) {
    return {
      scope: 'group',
      group: g,
      deleted_before: 0,
      total_users: 0,
      indexed: 0,
      skipped: 0,
      errors: [],
    };
  }
  const deleted_before = await clearGroupIndexForGroup(kv, env, g);
  const storageKeys = await listKvUserStorageKeys(kv);

  let total_users = 0;
  let indexed = 0;
  let skipped = 0;
  const errors = [];
  for (const sk of storageKeys) {
    total_users++;
    try {
      const row = await readKvUserByStorageKey(kv, env, sk);
      if (!row || !row.value) {
        skipped++;
        continue;
      }
      const logicalKey = row.logicalKey || (sk.startsWith('phone:') ? sk : '');
      const phone = getPhoneFromPhoneKey(logicalKey);
      if (!phone) {
        skipped++;
        continue;
      }
      const info = getIndexInfoFromValue(row.value);
      if (info.group !== g) {
        skipped++;
        continue;
      }
      indexed += await upsertUserGroupIndex(kv, env, phone, row.value);
    } catch (e) {
      skipped++;
      errors.push({ key: sk, error: String(e && (e.message || e)) });
    }
  }

  return {
    scope: 'group',
    group: g,
    deleted_before,
    total_users,
    indexed,
    skipped,
    errors,
  };
}

/**
 * 按组列出成员：双扫 gix 桶 + 旧 group:{g}:；解密得到逻辑 phone / uk，再读主记录。
 * 响应 key 仍为逻辑 phone:
 */
export async function listUsersByGroupIndex(kv, env, group) {
  const g = normalizeGroup(group);
  if (!kv || !g) return [];

  const indexKeys = [];
  async function collect(prefix) {
    let cursor;
    do {
      const page = await kv.list({ prefix, limit: 1000, cursor });
      const keys = (page && page.keys) || [];
      for (const k of keys) {
        if (k && k.name) indexKeys.push(k.name);
      }
      cursor = page && !page.list_complete ? page.cursor : undefined;
    } while (cursor);
  }

  await collect(`group:${g}:`);
  if (hmacEnabled(env)) {
    try {
      const bucket = await buildGroupIndexBucket(env, g);
      await collect(GIX_PREFIX + bucket + ':');
    } catch {
      /* ignore */
    }
  }

  const seenLogical = new Set();
  const users = [];
  for (const ik of indexKeys) {
    try {
      let phone = '';
      let logicalKey = '';
      if (ik.startsWith(GIX_PREFIX)) {
        const payload = await readIndexPayload(kv, env, ik);
        if (!payload) continue;
        logicalKey =
          typeof payload.logicalKey === 'string'
            ? payload.logicalKey
            : payload.phone
              ? 'phone:' + String(payload.phone)
              : '';
        phone = getPhoneFromPhoneKey(logicalKey) || String(payload.phone || '');
      } else {
        const parts = String(ik).split(':');
        if (parts.length >= 4) phone = parts.slice(3).join(':');
        logicalKey = phone ? 'phone:' + phone : '';
      }
      if (!phone || !logicalKey) continue;
      if (seenLogical.has(logicalKey)) continue;
      seenLogical.add(logicalKey);

      const row = await readKvUser(kv, env, logicalKey);
      if (!row) continue;
      if (row.value && typeof row.value === 'object') {
        delete row.value.uuid;
        delete row.value.pwd;
      }
      users.push({
        key: logicalKey,
        value: row.value,
        metadata: row.metadata,
      });
    } catch {
      /* skip */
    }
  }
  users.sort((a, b) => String(a.key).localeCompare(String(b.key)));
  return users;
}
