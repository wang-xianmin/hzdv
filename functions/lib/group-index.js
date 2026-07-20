/**
 * 组索引维护：
 * 主记录仍是 phone:xxxx；索引为 group:{group}:{l|m}:{phone}
 */

import { readKvUser } from './kv-secure.js';

export function normalizeGroup(groupVal) {
  const g = String(groupVal == null ? '' : groupVal).trim();
  return g;
}

function normalizeRoleTag(gRoleVal) {
  const n = Number(gRoleVal);
  return n === 1 ? 'l' : 'm';
}

export function buildGroupIndexKey(group, roleTag, phone) {
  return `group:${group}:${roleTag}:${phone}`;
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

export async function removeUserGroupIndexes(kv, group, phone) {
  if (!kv || !group || !phone) return 0;
  const keys = [
    buildGroupIndexKey(group, 'l', phone),
    buildGroupIndexKey(group, 'm', phone),
  ];
  await Promise.all(keys.map((k) => kv.delete(k)));
  return keys.length;
}

export async function upsertUserGroupIndex(kv, phone, valueObj) {
  const { group, roleTag } = getIndexInfoFromValue(valueObj);
  if (!kv || !group || !phone) return 0;
  await removeUserGroupIndexes(kv, group, phone);
  const key = buildGroupIndexKey(group, roleTag, phone);
  const payload = JSON.stringify({
    phone,
    group,
    role: roleTag,
    updated_at: Date.now(),
  });
  await kv.put(key, payload);
  return 1;
}

export async function syncUserGroupIndexOnUpdate(kv, phone, prevValue, nextValue) {
  const prev = getIndexInfoFromValue(prevValue || {});
  const next = getIndexInfoFromValue(nextValue || {});
  let deleted = 0;
  let added = 0;
  if (prev.group) {
    deleted += await removeUserGroupIndexes(kv, prev.group, phone);
  }
  if (next.group) {
    added += await upsertUserGroupIndex(kv, phone, nextValue || {});
  }
  return { deleted, added };
}

/** 删除某一组号下所有索引键（group:{g}:l|m:phone），不影响其它组。 */
export async function clearGroupIndexForGroup(kv, group) {
  const g = normalizeGroup(group);
  if (!kv || !g) return 0;
  const prefix = `group:${g}:`;
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

export async function clearAllGroupIndexes(kv) {
  let cursor;
  let deleted = 0;
  do {
    const page = await kv.list({ prefix: 'group:', limit: 1000, cursor });
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

export async function rebuildAllGroupIndexes(kv, env) {
  const deleted_before = await clearAllGroupIndexes(kv);
  const phoneKeys = [];
  let cursor;
  do {
    const page = await kv.list({ prefix: 'phone:', limit: 1000, cursor });
    const keys = (page && page.keys) || [];
    for (const k of keys) {
      if (k && k.name) phoneKeys.push(k.name);
    }
    cursor = page && !page.list_complete ? page.cursor : undefined;
  } while (cursor);

  let total_users = 0;
  let indexed = 0;
  let skipped = 0;
  const errors = [];
  for (const key of phoneKeys) {
    total_users++;
    try {
      const row = await readKvUser(kv, env, key);
      if (!row || !row.value) {
        skipped++;
        continue;
      }
      const phone = getPhoneFromPhoneKey(key);
      if (!phone) {
        skipped++;
        continue;
      }
      indexed += await upsertUserGroupIndex(kv, phone, row.value);
    } catch (e) {
      skipped++;
      errors.push({ key, error: String(e && (e.message || e)) });
    }
  }

  return { deleted_before, total_users, indexed, skipped, errors };
}

/** 从全部 phone:* 用户记录中收集合法、去重后的组号（与邀请码组号规则一致） */
export async function collectDistinctGroupIdsFromKvUsers(kv, env) {
  if (!kv) return [];
  function groupIdOk(g) {
    const s = normalizeGroup(g);
    if (!s || s.length > 24) return "";
    if (!/^[\dA-Za-z._-]+$/.test(s)) return "";
    return s;
  }
  const phoneKeys = [];
  let cursor;
  do {
    const page = await kv.list({ prefix: "phone:", limit: 1000, cursor });
    const keys = (page && page.keys) || [];
    for (const k of keys) {
      if (k && k.name) phoneKeys.push(k.name);
    }
    cursor = page && !page.list_complete ? page.cursor : undefined;
  } while (cursor);

  const set = new Set();
  for (const key of phoneKeys) {
    try {
      const row = await readKvUser(kv, env, key);
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
 * 仅重建某一组的索引：先删 group:{g}:…，再扫描全部 phone:*，只对组号匹配的用户写入索引。
 * 不触碰其它组已有索引。
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
  const deleted_before = await clearGroupIndexForGroup(kv, g);
  const phoneKeys = [];
  let cursor;
  do {
    const page = await kv.list({ prefix: 'phone:', limit: 1000, cursor });
    const keys = (page && page.keys) || [];
    for (const k of keys) {
      if (k && k.name) phoneKeys.push(k.name);
    }
    cursor = page && !page.list_complete ? page.cursor : undefined;
  } while (cursor);

  let total_users = 0;
  let indexed = 0;
  let skipped = 0;
  const errors = [];
  for (const key of phoneKeys) {
    total_users++;
    try {
      const row = await readKvUser(kv, env, key);
      if (!row || !row.value) {
        skipped++;
        continue;
      }
      const phone = getPhoneFromPhoneKey(key);
      if (!phone) {
        skipped++;
        continue;
      }
      const info = getIndexInfoFromValue(row.value);
      if (info.group !== g) {
        skipped++;
        continue;
      }
      indexed += await upsertUserGroupIndex(kv, phone, row.value);
    } catch (e) {
      skipped++;
      errors.push({ key, error: String(e && (e.message || e)) });
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
