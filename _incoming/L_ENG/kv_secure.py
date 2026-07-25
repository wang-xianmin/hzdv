"""
与 functions/lib/kv-secure.js 对齐的 KV 加密（喂PDF0409 + 方案 A HMAC-as-key）。
环境变量：ENCRYPTION_KEY（32 字节 hex64 或 base64 或 utf8 恰 32 字符）、
HMAC_SECRET（新写必填）、ARGON2_MEMORY_KIB（默认 8192）、
ARGON2_TIME_COST（默认 1）、ARGON2_PARALLELISM（默认 1）。
新写 fail-closed：ENCRYPTION_KEY 与 HMAC_SECRET 均须配置；外层键 uk:{HMAC}。
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import re
import secrets
import time
import unicodedata
from typing import Any, Optional, Tuple

ENC_PREFIX = "e1."
UK_PREFIX = "uk:"
LEGACY_PHONE_PREFIX = "phone:"

_phone_key_re = re.compile(r"^phone:\d{6,20}$")
_zw_re = re.compile(r"[\u200B-\u200D\uFEFF]")


def strip_password_only(raw: str) -> str:
    """去零宽与 BOM；不做 NFKC（兼容旧 Argon 用原始全角 UTF-8 参与哈希）。"""
    return _zw_re.sub("", str(raw or "")).strip()


def normalize_password_for_auth(raw: str) -> str:
    """登录/存盘：strip + NFKC（全角英数字符等归一为半角兼容形）。"""
    return unicodedata.normalize("NFKC", strip_password_only(raw))


def assert_phone_key(key: str) -> None:
    if not isinstance(key, str) or not _phone_key_re.match(key):
        raise ValueError("Invalid key: expected phone:digits (6–20)")


def _decode_aes_key(raw: str) -> Optional[bytes]:
    t = (raw or "").strip()
    if not t:
        return None
    if re.fullmatch(r"[0-9a-fA-F]{64}", t):
        return bytes.fromhex(t)
    try:
        b = base64.b64decode(t.strip(), validate=False)
        if len(b) == 32:
            return b
    except Exception:
        pass
    u = t.encode("utf-8")
    if len(u) == 32:
        return u
    return None


def _parse_hmac_secret() -> Optional[bytes]:
    t = (os.environ.get("HMAC_SECRET") or "").strip()
    if not t:
        return None
    if re.fullmatch(r"[0-9a-fA-F]{64}", t):
        return bytes.fromhex(t)
    return t.encode("utf-8")


def encryption_enabled() -> bool:
    return _decode_aes_key(os.environ.get("ENCRYPTION_KEY", "")) is not None


def hmac_enabled() -> bool:
    s = _parse_hmac_secret()
    return bool(s)


def require_opaque_write_secrets() -> None:
    if not encryption_enabled() or not hmac_enabled():
        raise RuntimeError(
            "ENCRYPTION_KEY and HMAC_SECRET required for new KV writes (fail-closed)"
        )


def hmac_hex(message: str) -> str:
    sec = _parse_hmac_secret()
    if not sec:
        raise RuntimeError("HMAC_SECRET missing")
    return hmac.new(sec, str(message).encode("utf-8"), hashlib.sha256).hexdigest()


def phone_to_storage_key(logical_key: str) -> str:
    assert_phone_key(logical_key)
    return UK_PREFIX + hmac_hex(logical_key)


def is_uk_storage_key(key: str) -> bool:
    return isinstance(key, str) and key.startswith(UK_PREFIX)


def is_legacy_phone_storage_key(key: str) -> bool:
    return isinstance(key, str) and bool(_phone_key_re.match(key))


def _positive_int_env(name: str, fallback: int) -> int:
    try:
        v = int(os.environ.get(name) or str(fallback))
        return v if v > 0 else fallback
    except ValueError:
        return fallback


def _argon2_memory_kib() -> int:
    return _positive_int_env("ARGON2_MEMORY_KIB", 8192)


def _argon2_time_cost() -> int:
    return _positive_int_env("ARGON2_TIME_COST", 1)


def _argon2_parallelism() -> int:
    return _positive_int_env("ARGON2_PARALLELISM", 1)


def _hash_pwd_argon2id(password: str) -> str:
    from argon2 import PasswordHasher
    from argon2.low_level import Type

    mem = _argon2_memory_kib()
    ph = PasswordHasher(
        time_cost=_argon2_time_cost(),
        memory_cost=mem,
        parallelism=_argon2_parallelism(),
        type=Type.ID,
    )
    return ph.hash(password)


def _is_argon2_encoded(s: str) -> bool:
    return isinstance(s, str) and s.startswith("$argon2")


def verify_password_from_value(value: dict, password: str) -> bool:
    """兼容 value.pwd_hash / value.pwd(历史哈希或明文) 的密码校验。"""
    if not isinstance(value, dict):
        return False
    pwd_hash = value.get("pwd_hash")
    pwd_raw = value.get("pwd")
    norm = normalize_password_for_auth(password)
    stripped = strip_password_only(password)

    def _argon2_verify(encoded: str, pwd: str) -> bool:
        try:
            from argon2 import PasswordHasher

            return PasswordHasher().verify(encoded, pwd)
        except Exception:
            return False

    if isinstance(pwd_hash, str) and pwd_hash.startswith("$argon2"):
        if _argon2_verify(pwd_hash, norm):
            return True
        if stripped != norm and _argon2_verify(pwd_hash, stripped):
            return True
        return False
    if isinstance(pwd_raw, str) and pwd_raw.startswith("$argon2"):
        if _argon2_verify(pwd_raw, norm):
            return True
        if stripped != norm and _argon2_verify(pwd_raw, stripped):
            return True
        return False
    if isinstance(pwd_raw, str):
        return normalize_password_for_auth(pwd_raw) == norm
    return False


def hash_pwd_in_value(value: dict) -> dict:
    """未启用 ENCRYPTION_KEY 时保持明文 pwd，便于本地无 argon2 依赖。"""
    out = dict(value)
    p = out.get("pwd")
    if not isinstance(p, str) or not p:
        return out
    if p.startswith("$"):
        return out
    if not encryption_enabled():
        if not _is_argon2_encoded(p):
            out["pwd"] = normalize_password_for_auth(p)
        return out
    if not _is_argon2_encoded(p):
        out["pwd"] = _hash_pwd_argon2id(normalize_password_for_auth(p))
    return out


def _compute_key_mac(kv_key: str) -> str:
    sec = _parse_hmac_secret()
    if not sec:
        return ""
    return hmac.new(sec, kv_key.encode("utf-8"), hashlib.sha256).hexdigest()


def _timing_safe_eq_hex(a: str, b: str) -> bool:
    return hmac.compare_digest(a.lower(), b.lower())


def _encrypt_inner(inner: dict) -> str:
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    key = _decode_aes_key(os.environ.get("ENCRYPTION_KEY", "") or "")
    if not key:
        raise RuntimeError("ENCRYPTION_KEY missing")
    aes = AESGCM(key)
    iv = secrets.token_bytes(16)
    plain = json.dumps(inner, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    ct = aes.encrypt(iv, plain, None)
    combined = iv + ct
    return ENC_PREFIX + base64.b64encode(combined).decode("ascii")


def _decrypt_inner(stored: str) -> dict:
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    key = _decode_aes_key(os.environ.get("ENCRYPTION_KEY", "") or "")
    if not key:
        raise RuntimeError("ENCRYPTION_KEY missing")
    if not isinstance(stored, str) or not stored.startswith(ENC_PREFIX):
        raise ValueError("Not an encrypted KV value")
    combined = base64.b64decode(stored[len(ENC_PREFIX) :].encode("ascii"))
    if len(combined) < 16 + 16:
        raise ValueError("Ciphertext too short")
    iv, ct = combined[:16], combined[16:]
    aes = AESGCM(key)
    plain = aes.decrypt(iv, ct, None)
    inner = json.loads(plain.decode("utf-8"))
    if not isinstance(inner, dict):
        raise ValueError("Invalid inner payload")
    return inner


def _verify_key_mac(kv_key: str, mac_hex: str) -> None:
    if not hmac_enabled():
        return
    expected = _compute_key_mac(kv_key)
    got = mac_hex if isinstance(mac_hex, str) else ""
    if not _timing_safe_eq_hex(expected, got):
        raise ValueError("KV key 完整性校验失败")


def write_kv_user(kv_key: str, value: dict, metadata: dict) -> dict:
    """
    返回写入 Flask 内存条目的 dict。
    调用方须用 phone_to_storage_key(kv_key) 作为 store 的键；禁止再以明文 phone: 写入。
    """
    assert_phone_key(kv_key)
    require_opaque_write_secrets()
    saved_at = time.time()
    value_for_store = hash_pwd_in_value(value)

    key_mac = _compute_key_mac(kv_key)
    meta_obj = dict(metadata) if isinstance(metadata, dict) else {}
    inner = {
        "v": 2,
        "value": value_for_store,
        "metadata": meta_obj,
        "savedAt": int(saved_at * 1000),
        "keyMac": key_mac,
        "logicalKey": kv_key,
    }
    enc = _encrypt_inner(inner)
    return {
        "_kv_enc": True,
        "body": enc,
        "metadata": meta_obj,
        "saved_at": saved_at,
        "_kv_key": kv_key,
        "_storage_key": phone_to_storage_key(kv_key),
    }


def read_kv_user(
    entry: Any, kv_key: Optional[str] = None
) -> Optional[Tuple[dict, dict, Optional[float]]]:
    """
    从 register_kv_store 条目解析 (value, metadata, saved_at)。
    entry 为旧版 {value, metadata, saved_at} 或加密版 { _kv_enc, body, metadata, saved_at, _kv_key }。
    """
    if not entry or not isinstance(entry, dict):
        return None

    if entry.get("_kv_enc") and encryption_enabled():
        inner = _decrypt_inner(entry["body"])
        meta = entry.get("metadata")
        if inner.get("v", 0) >= 2 and isinstance(inner.get("metadata"), dict):
            meta = inner["metadata"]
        if not isinstance(meta, dict):
            raise ValueError("加密记录缺少 metadata")
        logical = None
        if isinstance(inner.get("logicalKey"), str) and _phone_key_re.match(
            inner["logicalKey"]
        ):
            logical = inner["logicalKey"]
        k = logical or kv_key or entry.get("_kv_key")
        if isinstance(k, str):
            _verify_key_mac(k, inner.get("keyMac") or "")
        val = inner.get("value")
        if not isinstance(val, dict):
            raise ValueError("Invalid value in encrypted payload")
        sa = inner.get("savedAt")
        saved_at = sa / 1000.0 if isinstance(sa, (int, float)) else entry.get("saved_at")
        return val, meta, saved_at

    if isinstance(entry.get("value"), dict) and isinstance(entry.get("metadata"), dict):
        return entry["value"], entry["metadata"], entry.get("saved_at")

    return None


def resolve_store_entry(
    store: dict, logical_key: str
) -> Tuple[Optional[Any], Optional[str], str]:
    """
    双读：先 uk: 后旧 phone:。
    返回 (entry, storage_key, logical_key)；未命中则 (None, None, logical_key)。
    """
    assert_phone_key(logical_key)
    if hmac_enabled():
        try:
            sk = phone_to_storage_key(logical_key)
            if sk in store:
                return store[sk], sk, logical_key
        except Exception:
            pass
    if logical_key in store:
        return store[logical_key], logical_key, logical_key
    return None, None, logical_key


def put_store_user(store: dict, logical_key: str, value: dict, metadata: dict) -> str:
    """写入 uk: 键；顺带删除旧 phone: 键。返回 storage_key。"""
    assert_phone_key(logical_key)
    entry = write_kv_user(logical_key, value, metadata)
    sk = entry.get("_storage_key") or phone_to_storage_key(logical_key)
    store[sk] = entry
    store.pop(logical_key, None)
    return sk


def delete_store_user(store: dict, logical_key: str) -> None:
    assert_phone_key(logical_key)
    store.pop(logical_key, None)
    if hmac_enabled():
        try:
            store.pop(phone_to_storage_key(logical_key), None)
        except Exception:
            pass


def kv_user_exists(store: dict, logical_key: str) -> bool:
    entry, _, _ = resolve_store_entry(store, logical_key)
    return entry is not None


def iter_user_logical_keys(store: dict) -> list:
    """扫描 uk: + 旧 phone:，返回去重后的逻辑 phone: 列表。"""
    seen = set()
    out = []
    for key, entry in list(store.items()):
        logical = None
        if is_legacy_phone_storage_key(key):
            logical = key
        elif is_uk_storage_key(key):
            try:
                if isinstance(entry, dict):
                    lk = entry.get("_kv_key")
                    if isinstance(lk, str) and _phone_key_re.match(lk):
                        logical = lk
                    elif entry.get("_kv_enc") and encryption_enabled():
                        inner = _decrypt_inner(entry["body"])
                        if isinstance(inner.get("logicalKey"), str):
                            logical = inner["logicalKey"]
            except Exception:
                continue
        if logical and logical not in seen:
            seen.add(logical)
            out.append(logical)
    out.sort()
    return out
