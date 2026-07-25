import base64
from flask import Flask, jsonify, request, Response, send_from_directory
from flask_cors import CORS
import html as html_module
import json
import os
import random
import ssl
import uuid as uuid_lib
import re
import smtplib
import time
from email.header import Header
from email.mime.text import MIMEText

import kv_secure
import urllib.error
import urllib.parse
import urllib.request

# 全局：xrec 采集结果缓存（按 session_id 隔离，供前端轮询）
_xrec_session_store = {}


def _xrec_norm_session_id(raw):
    s = str(raw or '').strip()
    if not s:
        print('[xrec-warn] session_id 为空，降级为 __default__', flush=True)
        return '__default__'
    if len(s) > 80:
        s = s[:80]
    if not re.match(r'^[A-Za-z0-9._-]+$', s):
        print(f'[xrec-warn] session_id 含非法字符，降级为 __default__: raw={raw!r}', flush=True)
        return '__default__'
    return s


def _xrec_session_bucket(session_id):
    sid = _xrec_norm_session_id(session_id)
    if sid not in _xrec_session_store:
        _xrec_session_store[sid] = {'partial': {}, 'last_collect': None}
    return _xrec_session_store[sid]

XREC_PORT = 8899
_XREC_SERVER_SCRIPT = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "scripts", "xrec-server.py"
)

app = Flask(__name__)
CORS(app)  # 启用 CORS 支持

_PUBLIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "public")


@app.route("/config.js")
def serve_config_js():
    return send_from_directory(_PUBLIC_DIR, "config.js", mimetype="application/javascript")


@app.route("/vendor/<path:filename>")
def serve_vendor(filename):
    return send_from_directory(os.path.join(_PUBLIC_DIR, "vendor"), filename)


@app.route("/js/<path:filename>")
def serve_public_js(filename):
    return send_from_directory(os.path.join(_PUBLIC_DIR, "js"), filename)


@app.route("/manifest.json")
def serve_manifest():
    return send_from_directory(
        _PUBLIC_DIR,
        "manifest.json",
        mimetype="application/manifest+json",
    )


@app.route("/icons/<path:filename>")
def serve_icons(filename):
    return send_from_directory(os.path.join(_PUBLIC_DIR, "icons"), filename)


# 站点根 URL：本地调试默认本机；部署 Pages 时设环境变量 SITE_URL=https://你的域名
SITE_URL = os.environ.get("SITE_URL", "http://127.0.0.1:5001")

# 获取本机局域网 IP 地址（随网段变化自动适配，不写死某一网段）
import socket
import subprocess
import sys


def _is_usable_lan_ip(ip):
    """排除回环、链路本地，其余由路由选出的 IPv4 均可用于二维码/手机访问。"""
    if not ip or ip == "127.0.0.1":
        return False
    if ip.startswith("169.254."):
        return False
    return True


def _is_private_ipv4(ip):
    if not ip or ip.count(".") != 3:
        return False
    try:
        a, b, c, d = (int(x) for x in ip.split("."))
    except ValueError:
        return False
    if a == 10:
        return True
    if a == 172 and 16 <= b <= 31:
        return True
    if a == 192 and b == 168:
        return True
    return False


def get_local_ip():
    # 方法1：UDP 出口路由（常见 WiFi/以太网下能拿到本机局域网地址）
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.settimeout(0.5)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        if _is_usable_lan_ip(ip):
            return ip
    except Exception:
        pass

    # 方法2：netifaces 枚举（若已安装）
    try:
        import netifaces

        for interface in netifaces.interfaces():
            addrs = netifaces.ifaddresses(interface)
            if netifaces.AF_INET in addrs:
                for addr_info in addrs[netifaces.AF_INET]:
                    ip_addr = addr_info.get("addr")
                    if _is_usable_lan_ip(ip_addr) and _is_private_ipv4(ip_addr):
                        return ip_addr
    except Exception:
        pass

    # 方法3：macOS 常见网卡名
    for iface in ("en0", "en1", "en2", "bridge100"):
        try:
            out = subprocess.run(
                ["ipconfig", "getifaddr", iface],
                capture_output=True,
                text=True,
                timeout=2,
            )
            if out.returncode == 0 and out.stdout.strip():
                ip = out.stdout.strip()
                if _is_usable_lan_ip(ip):
                    return ip
        except Exception:
            pass

    return "127.0.0.1"


# 模拟 KV 存储（用于本地开发）
scan_data_store = {}

# 新人注册写入的完整记录：Key -> { value, metadata, saved_at } 或 kv_secure 加密形态
register_kv_store = {}

# 全站新人默认组（无邀请链接），对应 Pages KV 键 site:default_register_group
_mock_site_default_register_group = ""

# 小组六位邀请码：组号 -> 六位数字串（与 Pages invite:group:* 行为一致）
_mock_group_invites = {}

# 本地头像模拟存储：列表项含 owner_uuid（customs 归属）、uuid（行 id）、category（presets|customs）
_mock_avatar_rows = []


def _sanitize_default_register_group(raw) -> str:
    if raw is None:
        return ""
    s = str(raw).strip()
    if not s or len(s) > 24:
        return ""
    if not re.match(r"^[\dA-Za-z._-]+$", s):
        return ""
    return s


def _normalize_invite_six_digits(raw) -> str:
    d = re.sub(r"\D", "", str(raw or ""))[:6]
    return d if len(d) == 6 else ""


def _random_invite_code_six() -> str:
    return str(random.randint(0, 999999)).zfill(6)


def _sync_mock_kv_by_phone_from_row(key: str, value: dict, metadata: dict) -> None:
    if not key.startswith("phone:"):
        return
    phone = key[6:].strip()
    if not phone:
        return
    try:
        u_st = int(metadata.get("status", 1) or 1)
    except (TypeError, ValueError):
        u_st = 1
    MOCK_KV_BY_PHONE[phone] = {
        "username": value.get("name") or "",
        "email": value.get("email") or "",
        "u_status": u_st,
        "other_data": value.get("uuid") or "",
    }

# 模拟「按手机号查用户」，供 /api/check-user 与注册写入共用（内存，重启清空）
MOCK_KV_BY_PHONE = {
    "13800138000": {
        "username": "测试用户",
        "email": "test@example.com",
        "u_status": 1,
        "other_data": "其他信息",
    },
    "13800138001": {
        "username": "注销用户",
        "email": "deleted@example.com",
        "u_status": 3,
        "other_data": "已注销",
    },
    "13800138002": {
        "username": "邮箱不匹配用户",
        "email": "different@example.com",
        "u_status": 1,
        "other_data": "邮箱不匹配",
    },
}

@app.route('/get-local-ip')
def get_local_ip_route():
    # 每次请求重新探测，换网段/重连 WiFi 后无需重启服务
    return jsonify({"ip": get_local_ip()})


def _https_ssl_context():
    """macOS 自带 Python 常缺根证书；优先 certifi，否则系统 CA，最后才跳过校验。"""
    try:
        import certifi
        return ssl.create_default_context(cafile=certifi.where())
    except ImportError:
        pass
    paths = ssl.get_default_verify_paths()
    if paths.cafile and os.path.isfile(paths.cafile):
        try:
            return ssl.create_default_context(cafile=paths.cafile)
        except ssl.SSLError:
            pass
    for cafile in (
        '/etc/ssl/cert.pem',
        '/private/etc/ssl/cert.pem',
        '/opt/homebrew/etc/openssl@3/cert.pem',
        '/usr/local/etc/openssl@3/cert.pem',
    ):
        if os.path.isfile(cafile):
            try:
                return ssl.create_default_context(cafile=cafile)
            except ssl.SSLError:
                pass
    print('[app] WARN: 未找到 CA 证书，HTTPS 跳过校验；建议 pip install certifi', flush=True)
    return ssl._create_unverified_context()


def _https_urlopen(req, timeout=15):
    return urllib.request.urlopen(req, timeout=timeout, context=_https_ssl_context())


def _x_import_status_id(url):
    m = re.search(r'/status/(\d+)', str(url or ''))
    return m.group(1) if m else ''


def _x_import_decode_html(s):
    t = str(s or '')
    t = re.sub(r'<br\s*/?>', '\n', t, flags=re.I)
    t = re.sub(r'<[^>]+>', '', t)
    return html_module.unescape(t).strip()


def _twimg_media_id(url):
    m = re.search(r'/media/([A-Za-z0-9_-]+)', str(url or ''))
    return m.group(1) if m else ''


def _x_import_media_from_html(html):
    """从 X 页或 oEmbed HTML 抽 twimg 媒体 URL（同图去重）。"""
    hay = str(html or '')
    out = []
    seen_ids = set()
    patterns = (
        (r'https://pbs\.twimg\.com/media/[A-Za-z0-9_-]+\.(?:jpg|jpeg|png|webp)(?::large)?', 'image'),
        (r'https://pbs\.twimg\.com/(?:amplify_video_thumb|ext_tw_video_thumb)/[^\s"\'<>\\]+', 'video'),
    )
    for pat, mtype in patterns:
        for m in re.finditer(pat, hay, flags=re.I):
            u = m.group(0)
            mid = _twimg_media_id(u)
            if mid:
                if mid in seen_ids:
                    continue
                seen_ids.add(mid)
            elif u in seen_ids:
                continue
            else:
                seen_ids.add(u)
            out.append({
                'type': mtype,
                'origin_url': u,
                'preview_url': u if mtype == 'video' else '',
            })
    return out


def _x_import_via_oembed_and_page(x_url, warnings):
    """本地 oEmbed + X 页抓取（upstream 不可用时的真实判定）。"""
    status_id = _x_import_status_id(x_url)
    author_name = ''
    author_handle = ''
    text = ''
    oembed_html = ''
    endpoint = 'https://publish.twitter.com/oembed?' + urllib.parse.urlencode({
        'url': x_url,
        'omit_script': 'true',
        'dnt': 'true',
    })
    req = urllib.request.Request(
        endpoint,
        headers={'Accept': 'application/json', 'User-Agent': 'hobby-era-x-import/1.0'},
    )
    with _https_urlopen(req, timeout=25) as r:
        payload = json.loads(r.read().decode('utf-8') or '{}')
    oembed_html = str(payload.get('html') or '')
    author_name = str(payload.get('author_name') or '').strip()
    author_url = str(payload.get('author_url') or '')
    if author_url:
        parts = urllib.parse.urlparse(author_url).path.strip('/').split('/')
        author_handle = parts[0] if parts else ''
    m = re.search(r'<p[^>]*>([\s\S]*?)</p>', oembed_html, flags=re.I)
    if m:
        text = _x_import_decode_html(m.group(1))
        # X API 返回的原文会附带 pic.twitter.com / t.co 短链，前端渲染时会隐藏，这里直接过滤
        text = re.sub(r'\s*(?:https?://)?(t\.co|pic\.twitter\.com)/\S+', '', text).strip()
    media = _x_import_media_from_html(oembed_html)
    page_html = ''
    try:
        page_req = urllib.request.Request(
            x_url,
            headers={'User-Agent': 'Mozilla/5.0 (compatible; hobby-era-x-import/1.0)'},
        )
        with _https_urlopen(page_req, timeout=25) as pr:
            page_html = pr.read().decode('utf-8', 'replace')
        for row in _x_import_media_from_html(page_html):
            row_id = _twimg_media_id(row.get('origin_url') or '')
            dup = False
            for x in media:
                x_id = _twimg_media_id(x.get('origin_url') or '')
                if row_id and x_id and row_id == x_id:
                    dup = True
                    break
                if row.get('origin_url') == x.get('origin_url'):
                    dup = True
                    break
            if not dup:
                media.append(row)
    except Exception as e:
        warnings.append(f'X 页面抓取失败: {e}')
    has_video = any(m.get('type') == 'video' for m in media)
    all_image = bool(media) and all(m.get('type') == 'image' for m in media)
    needs_xrec = has_video
    if all_image:
        needs_xrec = False
    elif not media and re.search(r'/status/\d+/video/\d+', page_html + oembed_html, re.I):
        needs_xrec = True
        warnings.append('疑似视频帖，本地未解析出媒体')
    deduped_media = []
    seen_media_ids = set()
    for m in media:
        ou = str(m.get('origin_url') or '')
        mid = _twimg_media_id(ou)
        key = mid or ou
        if key in seen_media_ids:
            continue
        seen_media_ids.add(key)
        deduped_media.append(m)
    media = deduped_media
    quote = {
        'mode': 'fallback',
        'source_url': x_url,
        'status_id': status_id or '',
        'author_name': author_name,
        'author_handle': author_handle,
        'text': text,
        'source_label': '来源：X',
        'fetched_at': int(time.time() * 1000),
        'media': media,
        'media_report': {
            'strategy': 'oembed_local_page',
            'source': {'official_api_used': False, 'oembed_ok': True, 'open_graph_ok': bool(page_html)},
            'media': {'fetched_count': len(media), 'r2_stored_count': 0, 'fallback_count': len(media)},
            'final_tier': 'external_media_fallback' if media else 'no_media',
            'embed_tweet': False,
        },
        'has_full_content': False,
        'embed_tweet': False,
        'prefer_embed': True,
        'needs_xrec': needs_xrec,
    }
    return quote


def _is_bad_translation(text):
    """MyMemory 超限/报错时会返回英文错误句，不能当译文展示。"""
    s = str(text or '').strip()
    if not s:
        return True
    upper = s.upper()
    for marker in (
        'QUERY LENGTH LIMIT',
        'MAX ALLOWED QUERY',
        'MYMEMORY WARNING',
        'INVALID LANGUAGE PAIR',
        'AUTO GENERATED TRANSLATION',
    ):
        if marker in upper:
            return True
    return False


def _xrec_translate_chunk(chunk):
    tr_url = (
        'https://api.mymemory.translated.net/get?q='
        + urllib.parse.quote(chunk)
        + '&langpair=en|zh-CN'
    )
    req = urllib.request.Request(tr_url, headers={'User-Agent': 'L_ENG-xrec/1.0'})
    with _https_urlopen(req, timeout=15) as tr_resp:
        tr_body = json.loads(tr_resp.read().decode('utf-8'))
    translated = ''
    if tr_body.get('responseData') and tr_body['responseData'].get('translatedText'):
        translated = str(tr_body['responseData']['translatedText']).strip()
    if _is_bad_translation(translated):
        return '', False
    return translated, bool(translated)


def _xrec_split_for_translation(text, max_len=450):
    """MyMemory 免费版单次 query 上限约 500 字符。"""
    text = str(text or '').strip()
    if len(text) <= max_len:
        return [text]
    chunks = []
    rest = text
    while rest:
        if len(rest) <= max_len:
            chunks.append(rest)
            break
        slice_ = rest[:max_len]
        cut = slice_.rfind('\n\n')
        if cut < 80:
            cut = slice_.rfind('\n')
        if cut < 80:
            cut = slice_.rfind('. ')
        if cut < 80:
            cut = slice_.rfind(' ')
        if cut < 80:
            cut = max_len
        chunks.append(rest[:cut].strip())
        rest = rest[cut:].strip()
    return [c for c in chunks if c]


def _xrec_translate_doc_text(doc_text):
    """将 X 帖英文文档译成中文；已是中文则原样返回。返回 (translation, ok)。
    策略：OpenAI → Gemini → MyMemory → Google"""
    text = str(doc_text or '').strip()
    if not text:
        return '', False
    cjk_count = len(re.findall(r'[\u4e00-\u9fff]', text))
    total_len = len(text.replace(' ', '').replace('\n', ''))
    if total_len > 12 and cjk_count / total_len >= 0.45:
        return text, True

    # 1. OpenAI
    openai_key = os.environ.get('OPENAI_API_KEY', '').strip()
    if openai_key:
        try:
            result = _translate_with_openai(text, openai_key)
            if result:
                return result, True
        except Exception as e:
            print(f'[xrec-save] OpenAI failed: {e}', flush=True)

    # 2. Gemini
    gemini_key = os.environ.get('GEMINI_API_KEY', '').strip()
    if gemini_key:
        try:
            result = _translate_with_gemini(text, gemini_key)
            if result:
                return result, True
        except Exception as e:
            print(f'[xrec-save] Gemini failed: {e}', flush=True)

    # 3. MyMemory（分块）
    parts = _xrec_split_for_translation(text, 450)
    translated_parts = []
    mymemory_ok = True
    for part in parts:
        tr, ok = _xrec_translate_chunk(part)
        if not ok:
            print(f'[xrec-save] MyMemory chunk 失败 len={len(part)}', flush=True)
            mymemory_ok = False
            break
        translated_parts.append(tr)
    if mymemory_ok:
        joiner = '\n' if '\n' in text else ' '
        result = joiner.join(translated_parts).strip()
        if result and not _is_bad_translation(result):
            return result, True

    # 4. Google 兜底
    try:
        result = _translate_with_google(text, 'zh-CN')
        if result:
            return result, True
    except Exception as e:
        print(f'[xrec-save] Google failed: {e}', flush=True)

    return '', False


def _turnstile_siteverify_result(token):
    """调用 Cloudflare Turnstile siteverify；成功返回解析后的 dict，失败返回 None。"""
    if not token:
        return None
    secret = (os.environ.get("TURNSTILE_SECRET_KEY") or "").strip()
    if not secret:
        return None
    payload = urllib.parse.urlencode(
        {"secret": secret, "response": token}
    ).encode("utf-8")
    req = urllib.request.Request(
        "https://challenges.cloudflare.com/turnstile/v0/siteverify",
        data=payload,
        method="POST",
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except (urllib.error.URLError, ValueError, json.JSONDecodeError):
        return None


@app.route("/api/verify-turnstile", methods=["POST"])
def verify_turnstile():
    """校验 Turnstile token。须在环境变量 TURNSTILE_SECRET_KEY 中配置 Secret。"""
    data = request.get_json(silent=True) or {}
    token = data.get("token")
    if not token:
        return jsonify({"success": False, "error-codes": ["missing-input-response"]}), 400

    if not (os.environ.get("TURNSTILE_SECRET_KEY") or "").strip():
        return jsonify(
            {
                "success": False,
                "error-codes": ["missing-secret"],
                "error": "TURNSTILE_SECRET_KEY not configured",
            }
        ), 503

    result = _turnstile_siteverify_result(token)
    if result is None:
        return jsonify({"success": False, "error-codes": ["internal-error"]}), 502

    status = 200 if result.get("success") else 400
    return jsonify(result), status


@app.route('/api/scan-login', methods=['GET', 'POST'])
def scan_login():
    if request.method == 'GET':
        # 打印调试信息
        print(f"GET 请求 - URL: {request.url}")
        print(f"GET 请求 - User-Agent: {request.headers.get('User-Agent')}")
        
        # 兼容两种大小写形式的 sessionId
        session_id = request.args.get('sessionId') or request.args.get('sessionid')
        
        if not session_id:
            return jsonify({'exists': False, 'msg': 'Missing sessionId'}), 400
            
        if session_id in scan_data_store:
            # 找到数据，检查是否过期（5分钟）
            data = scan_data_store[session_id]
            if time.time() - data.get('timestamp', 0) < 300:
                user_data = data.get('user_data', {})
                # 检查验证码是否过期（3分钟）
                code_timestamp = data.get('code_timestamp', 0)
                if time.time() - code_timestamp < 180:
                    user_data['verificationCodeValid'] = True
                else:
                    user_data['verificationCodeValid'] = False
                
                print(f"GET 请求 - 找到数据: {user_data}")
                return jsonify({
                    'exists': True,
                    'data': user_data
                })
            else:
                print(f"GET 请求 - 数据已过期: {session_id}")
                # 数据过期，删除
                del scan_data_store[session_id]
        else:
            print(f"GET 请求 - 未找到 sessionId: {session_id}")
        
        return jsonify({'exists': False})
    
    elif request.method == 'POST':
        # 处理 POST 请求 - 手机端扫码后提交数据
        try:
            data = request.get_json()
            if not data:
                return jsonify({'error': 'No JSON data provided'}), 400
            
            session_id = data.get('sessionId')
            user_data = data.get('data')
            
            if not session_id or not user_data:
                return jsonify({'error': 'Missing sessionId or data'}), 400
            
            # 调试信息
            print(f"POST 请求接收到的 session_id: {session_id}")
            print(f"POST 请求接收到的 user_data: {user_data}")
            
            # 存储扫码数据
            scan_data_store[session_id] = {
                'user_data': user_data,
                'timestamp': time.time(),
                'code_timestamp': time.time()  # 验证码生成时间
            }
            
            print(f"数据已存储，当前存储的 session IDs: {list(scan_data_store.keys())}")
            
            return jsonify({'success': True, 'message': 'Data stored'})
        
        except Exception as e:
            print(f"POST 请求错误: {str(e)}")
            return jsonify({'error': str(e)}), 500

@app.route("/mobile.html")
def mobile():
    # 读取并返回 mobile.html 文件内容
    try:
        with open('public/mobile.html', 'r', encoding='utf-8') as f:
            return f.read()
    except FileNotFoundError:
        return "mobile.html not found", 404


@app.route("/images/background.jpg")
def background_jpg():
    # 返回一个空的背景响应，防止 404
    return "", 204


def send_real_email(receiver_email, subject, content):
    """
    使用 SMTP 发送邮件。通过环境变量配置（见 docs/email-verification.md）。
    未配置时返回 False，由路由回退到模拟模式。
    """
    smtp_server = os.environ.get("SMTP_SERVER", "").strip()
    smtp_user = os.environ.get("SMTP_USER", "").strip()
    smtp_pass = os.environ.get("SMTP_PASS", "").strip()
    mail_from = os.environ.get("SMTP_FROM", "").strip() or smtp_user
    try:
        smtp_port = int(os.environ.get("SMTP_PORT", "465") or "465")
    except ValueError:
        smtp_port = 465

    if not smtp_server or not smtp_user or not smtp_pass:
        print(
            "警告: 未配置 SMTP（需环境变量 SMTP_SERVER、SMTP_USER、SMTP_PASS；可选 SMTP_FROM、SMTP_PORT）。"
            f"模拟未外发。收件人: {receiver_email}, 主题: {subject}"
        )
        return False

    try:
        message = MIMEText(content, "plain", "utf-8")
        message["From"] = mail_from
        message["To"] = receiver_email
        message["Subject"] = Header(subject, "utf-8")

        with smtplib.SMTP_SSL(smtp_server, smtp_port) as server:
            server.login(smtp_user, smtp_pass)
            server.sendmail(mail_from, [receiver_email], message.as_string())
        return True
    except Exception as e:
        print(f"发送真实邮件失败: {str(e)}")
        return False

@app.route("/api/send-email-code", methods=['POST'])
def send_email_code():
    try:
        data = request.get_json()
        if not data:
            return jsonify({'error': 'No JSON data provided'}), 400
        
        email = data.get('email')
        code = data.get('code')
        is_auth = data.get('is_auth', False)
        
        if not email or not code:
            return jsonify({'error': 'Missing email or code'}), 400
        
        subject = "验证码" if not is_auth else "授权码"
        content = f"您的{subject}是: {code}。请在3分钟内输入。"
        
        # 尝试发送真实邮件
        sent = send_real_email(email, subject, content)
        
        if sent:
            message = f"{subject}已发送到您的邮箱"
        else:
            # 如果发送失败（例如未配置），则回退到模拟模式并提示用户
            print(f"模拟模式 - {subject}: {code} -> 目标: {email}")
            message = f"{subject}已发送（模拟模式，请在后台日志查看）"
        
        return jsonify({'success': True, 'message': message})
    
    except Exception as e:
        print(f"发送邮件验证码错误: {str(e)}")
        return jsonify({'error': str(e)}), 500

@app.route("/api/default-register-group", methods=["GET", "POST"])
def default_register_group():
    """与 Pages `default-register-group` 一致：GET 读默认组，POST 设置或清空。"""
    global _mock_site_default_register_group
    if request.method == "GET":
        return jsonify(
            {"success": True, "group": _mock_site_default_register_group or ""}
        )
    try:
        data = request.get_json(silent=True) or {}
        g = _sanitize_default_register_group(data.get("group"))
        if not g:
            _mock_site_default_register_group = ""
            return jsonify({"success": True, "group": ""})
        _mock_site_default_register_group = g
        return jsonify({"success": True, "group": g})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


@app.route("/api/group-invite-code", methods=["GET", "POST"])
def group_invite_code():
    """与 Pages group-invite-code 一致：GET 读六位码，POST 生成/刷新。"""
    global _mock_group_invites
    if request.method == "GET":
        g = _sanitize_default_register_group(request.args.get("group"))
        if not g:
            return jsonify({"success": False, "error": "Missing or invalid group"}), 400
        code = _mock_group_invites.get(g) or ""
        code = _normalize_invite_six_digits(code) if code else ""
        return jsonify({"success": True, "group": g, "code": code})
    try:
        data = request.get_json(silent=True) or {}
        g = _sanitize_default_register_group(data.get("group"))
        if not g:
            return jsonify({"success": False, "error": "Missing or invalid group"}), 400
        code = _random_invite_code_six()
        _mock_group_invites[g] = code
        return jsonify({"success": True, "group": g, "code": code})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


def _distinct_groups_from_register_kv_store():
    """与 Pages refresh-group-invite-codes 一致：从模拟 uk:/phone:* 记录收集组号。"""
    out = set()
    for logical in kv_secure.iter_user_logical_keys(register_kv_store):
        try:
            entry, _, _ = kv_secure.resolve_store_entry(register_kv_store, logical)
            parsed = kv_secure.read_kv_user(entry, logical) if entry else None
        except Exception:
            continue
        if not parsed:
            continue
        v, _, _ = parsed
        g = _sanitize_default_register_group((v or {}).get("group"))
        if g:
            out.add(g)
    return sorted(out)


@app.route("/api/refresh-group-invite-codes", methods=["POST"])
def refresh_group_invite_codes():
    """与 Pages refresh-group-invite-codes 一致：树根=全部相关组；选中某组=仅该组。"""
    global _mock_group_invites
    try:
        data = request.get_json(silent=True) or {}
        group_raw = data.get("group")
        group_raw = str(group_raw).strip() if group_raw is not None else ""
        if group_raw:
            g = _sanitize_default_register_group(group_raw)
            if not g:
                return jsonify({"success": False, "error": "Missing or invalid group"}), 400
            code = _random_invite_code_six()
            _mock_group_invites[g] = code
            return jsonify(
                {
                    "success": True,
                    "scope": "group",
                    "group": g,
                    "refreshed": 1,
                    "codes": [{"group": g, "code": code}],
                }
            )
        groups_set = set(_distinct_groups_from_register_kv_store())
        dg = _sanitize_default_register_group(_mock_site_default_register_group)
        if dg:
            groups_set.add(dg)
        codes = []
        for g in sorted(groups_set):
            code = _random_invite_code_six()
            _mock_group_invites[g] = code
            codes.append({"group": g, "code": code})
        return jsonify(
            {
                "success": True,
                "scope": "all",
                "refreshed": len(codes),
                "codes": codes,
            }
        )
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


@app.route("/api/list-kv-users", methods=["GET"])
def list_kv_users():
    """返回所有用户信息；响应 key 仍为逻辑 phone:（与 Pages list-kv-users 一致）。"""
    try:
        users = []
        for logical in kv_secure.iter_user_logical_keys(register_kv_store):
            try:
                entry, _, _ = kv_secure.resolve_store_entry(register_kv_store, logical)
                parsed = kv_secure.read_kv_user(entry, logical) if entry else None
            except Exception:
                continue
            if not parsed:
                continue
            v, m, _ = parsed
            users.append(
                {
                    "key": logical,
                    "value": v or {},
                    "metadata": m or {},
                }
            )
        return jsonify({"success": True, "users": users})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


@app.route("/api/register-kv-key-exists", methods=["GET"])
def register_kv_key_exists():
    """查询 KV 中是否已有该 key（新人注册前查重用；双读 uk:/phone:）。"""
    try:
        key = request.args.get("key")
        if not key or not isinstance(key, str):
            return jsonify({"success": False, "error": "Missing key"}), 400
        try:
            kv_secure.assert_phone_key(key)
        except ValueError as e:
            return jsonify({"success": False, "error": str(e)}), 400
        exists = kv_secure.kv_user_exists(register_kv_store, key)
        return jsonify({"success": True, "exists": bool(exists)})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


@app.route("/api/register-kv", methods=["POST"])
def register_kv():
    """新人注册：写入模拟 KV（与喂0403.pdf 结构一致），并同步到 MOCK_KV_BY_PHONE 供 check-user 使用。"""
    try:
        data = request.get_json(silent=True) or {}
        key = data.get("key")
        value = data.get("value")
        metadata = data.get("metadata")
        if not key or not isinstance(key, str):
            return jsonify({"success": False, "error": "Missing key"}), 400
        try:
            kv_secure.assert_phone_key(key)
        except ValueError as e:
            return jsonify({"success": False, "error": str(e)}), 400
        if not isinstance(value, dict) or not isinstance(metadata, dict):
            return jsonify(
                {"success": False, "error": "value and metadata must be JSON objects"}
            ), 400
        if kv_secure.kv_user_exists(register_kv_store, key):
            return jsonify(
                {
                    "success": False,
                    "error": "该手机已经注册！",
                    "code": "ALREADY_EXISTS",
                }
            ), 409
        # 显式跳过，或 Flask debug 本地开发（与 public/config.js 本地关闭 Turnstile 一致；生产勿开 debug）
        skip_ts = os.environ.get("REGISTER_KV_SKIP_TURNSTILE", "").lower() in (
            "1",
            "true",
            "yes",
        ) or bool(app.debug)
        if not skip_ts:
            tok = data.get("turnstileToken") or data.get("turnstile_token")
            if not tok:
                return jsonify(
                    {"success": False, "error": "Missing turnstileToken"}
                ), 400
            tr = _turnstile_siteverify_result(tok)
            if not tr or not tr.get("success"):
                return jsonify(
                    {
                        "success": False,
                        "error": "Turnstile verification failed",
                        "error-codes": (tr or {}).get("error-codes"),
                    }
                ), 400
        grp = _sanitize_default_register_group(value.get("group"))
        if grp and _mock_group_invites.get(grp):
            expected = _normalize_invite_six_digits(_mock_group_invites[grp])
            if len(expected) == 6:
                submitted = _normalize_invite_six_digits(
                    data.get("inviteCode") or data.get("invite_code") or ""
                )
                if submitted != expected:
                    return (
                        jsonify(
                            {
                                "success": False,
                                "error": "邀请码不正确，请向组长索取「组号(六位数字)」中的六位数字。",
                                "code": "INVITE_MISMATCH",
                            }
                        ),
                        403,
                    )
        try:
            kv_secure.put_store_user(register_kv_store, key, value, metadata)
        except Exception as e:
            print(f"[register-kv] write_kv_user 错误: {e}")
            return jsonify({"success": False, "error": str(e)}), 500
        entry, _, _ = kv_secure.resolve_store_entry(register_kv_store, key)
        parsed = kv_secure.read_kv_user(entry, key) if entry else None
        if parsed:
            v2, m2, _ = parsed
            _sync_mock_kv_by_phone_from_row(key, v2, m2)
        print(f"[register-kv] saved key={key} (opaque uk:)")
        return jsonify({"success": True, "key": key})
    except Exception as e:
        print(f"register-kv 错误: {e}")
        return jsonify({"success": False, "error": str(e)}), 500


@app.route("/api/update-kv-profile", methods=["POST"])
def update_kv_profile():
    """已存在 key 时更新 value/metadata（个人资料），与 Pages Functions 行为一致。"""
    try:
        data = request.get_json(silent=True) or {}
        key = data.get("key")
        value = data.get("value")
        metadata = data.get("metadata")
        if not key or not isinstance(key, str):
            return jsonify({"success": False, "error": "Missing key"}), 400
        try:
            kv_secure.assert_phone_key(key)
        except ValueError as e:
            return jsonify({"success": False, "error": str(e)}), 400
        if not isinstance(value, dict) or not isinstance(metadata, dict):
            return jsonify(
                {"success": False, "error": "value and metadata must be JSON objects"}
            ), 400
        entry, _, _ = kv_secure.resolve_store_entry(register_kv_store, key)
        if entry is None:
            return jsonify(
                {
                    "success": False,
                    "error": "用户记录不存在，无法更新",
                    "code": "NOT_FOUND",
                }
            ), 404
        try:
            prev = kv_secure.read_kv_user(entry, key)
        except Exception as e:
            print(f"[update-kv-profile] read_kv_user: {e}")
            return jsonify({"success": False, "error": f"KV 数据损坏: {e}"}), 500
        if not prev:
            return jsonify({"success": False, "error": "KV 数据格式无效"}), 500
        try:
            kv_secure.put_store_user(register_kv_store, key, value, metadata)
        except Exception as e:
            print(f"[update-kv-profile] write_kv_user: {e}")
            return jsonify({"success": False, "error": str(e)}), 500
        entry2, _, _ = kv_secure.resolve_store_entry(register_kv_store, key)
        parsed = kv_secure.read_kv_user(entry2, key) if entry2 else None
        if parsed:
            v2, m2, _ = parsed
            _sync_mock_kv_by_phone_from_row(key, v2, m2)
        print(f"[update-kv-profile] updated key={key}")
        return jsonify({"success": True, "key": key})
    except Exception as e:
        print(f"update-kv-profile 错误: {e}")
        return jsonify({"success": False, "error": str(e)}), 500


@app.route("/api/delete-kv-user", methods=["POST"])
def delete_kv_user():
    """从模拟 KV 删除用户；与 Pages delete-kv-user 一致。TODO: D1/R2 同步删除。"""
    try:
        data = request.get_json(silent=True) or {}
        key = data.get("key")
        if not key or not isinstance(key, str):
            return jsonify({"success": False, "error": "Missing key"}), 400
        try:
            kv_secure.assert_phone_key(key)
        except ValueError as e:
            return jsonify({"success": False, "error": str(e)}), 400
        if not kv_secure.kv_user_exists(register_kv_store, key):
            return jsonify(
                {"success": False, "error": "用户记录不存在", "code": "NOT_FOUND"}
            ), 404
        kv_secure.delete_store_user(register_kv_store, key)
        if key.startswith("phone:"):
            phone = key[6:].strip()
            if phone and phone in MOCK_KV_BY_PHONE:
                del MOCK_KV_BY_PHONE[phone]
        print(f"[delete-kv-user] deleted key={key}")
        return jsonify({"success": True, "key": key})
    except Exception as e:
        print(f"delete-kv-user 错误: {e}")
        return jsonify({"success": False, "error": str(e)}), 500


@app.route("/api/check-user", methods=['POST'])
def check_user():
    try:
        def normalize_email(v):
            raw = str(v or '').strip().lower()
            if '@' not in raw:
                return raw
            local, domain = raw.rsplit('@', 1)
            if domain == 'googlemail.com':
                domain = 'gmail.com'
            if domain == 'gmail.com':
                if '+' in local:
                    local = local.split('+', 1)[0]
                local = local.replace('.', '')
            return f'{local}@{domain}'

        data = request.get_json()
        if not data:
            return jsonify({'error': 'No JSON data provided'}), 400
        
        phone = str(data.get('phone') or '').strip()
        password_raw = '' if data.get('password') is None else str(data.get('password'))
        password_norm = kv_secure.normalize_password_for_auth(password_raw)
        email = str(data.get('email') or '').strip()
        username = str(data.get('username') or '').strip()
        email_norm = normalize_email(email)
        username_norm = username.lower()
        
        if not phone:
            return jsonify({'error': 'Missing phone number'}), 400

        key = f"phone:{str(phone).strip()}"
        entry, _, _ = kv_secure.resolve_store_entry(register_kv_store, key)
        if entry is not None:
            parsed = kv_secure.read_kv_user(entry, key)
            if not parsed:
                return jsonify({'success': False, 'error': 'KV 数据格式无效'}), 500
            value_obj, meta_obj, _ = parsed
            stored_email = value_obj.get('email', '') if isinstance(value_obj, dict) else ''
            stored_email_norm = normalize_email(stored_email)
            stored_username = value_obj.get('name', '') if isinstance(value_obj, dict) else ''
            stored_username_norm = str(stored_username or '').strip().lower()
            email_matches = (stored_email_norm == email_norm) if email else False
            username_matches = (stored_username_norm == username_norm) if username else False
            try:
                user_status = int(meta_obj.get('status', 1) or 1)
            except Exception:
                user_status = 1
            if password_norm:
                pwd_ok = kv_secure.verify_password_from_value(value_obj or {}, password_raw)
            else:
                pwd_ok = None
            type_raw = str(
                (meta_obj.get('type') if isinstance(meta_obj, dict) else '') or
                (meta_obj.get('uA') if isinstance(meta_obj, dict) else '') or ''
            ).strip()
            if set(type_raw).issubset({'0', '1'}) and type_raw:
                type_mask = int(type_raw, 2)
            else:
                try:
                    type_mask = int(type_raw or '0')
                except Exception:
                    type_mask = 0
            is_superuser = (type_mask & 1) != 0
            return jsonify({
                'success': True,
                'phone_exists': True,
                'password_matches': (bool(pwd_ok) if pwd_ok is not None else None),
                'user_status': user_status,
                'email_matches': email_matches,
                'username_matches': username_matches,
                'stored_email': stored_email,
                'stored_username': stored_username,
                'is_superuser': is_superuser,
                'user_data': {
                    'username': stored_username,
                    'email': stored_email,
                    'u_status': user_status,
                    'other_data': value_obj.get('uuid', '') if isinstance(value_obj, dict) else ''
                }
            })

        if phone in MOCK_KV_BY_PHONE:
            user_data = MOCK_KV_BY_PHONE[phone]
            user_status = user_data.get('u_status', 1)
            stored_email = user_data.get('email', '')
            stored_email_norm = normalize_email(stored_email)
            stored_username = user_data.get('username', '')
            stored_username_norm = str(stored_username or '').strip().lower()
            email_matches = (stored_email_norm == email_norm) if email else False
            username_matches = (stored_username_norm == username_norm) if username else False
            pwd_ok = (password_norm == "123456") if password_norm else None
            return jsonify({
                'success': True,
                'phone_exists': True,
                'password_matches': (bool(pwd_ok) if pwd_ok is not None else None),
                'user_status': user_status,
                'email_matches': email_matches,
                'username_matches': username_matches,
                'stored_email': stored_email,
                'stored_username': stored_username,
                'is_superuser': False,
                'user_data': user_data
            })

        return jsonify({
            'success': True,
            'phone_exists': False,
            'password_matches': None,
            'user_status': None,
            'email_matches': False,
            'username_matches': False,
            'stored_email': None,
            'stored_username': None,
            'is_superuser': False,
            'user_data': None
        })
    
    except Exception as e:
        print(f"查询用户错误: {str(e)}")
        return jsonify({'error': str(e)}), 500


@app.route('/api/avatar-save', methods=['POST'])
def avatar_save():
    try:
        data = request.get_json(silent=True) or {}
        owner_uuid = str(data.get('uuid') or '').strip()
        data_url = str(data.get('dataUrl') or '').strip()
        is_preset = bool(data.get('preset'))
        row_uuid = str(uuid_lib.uuid4()) if is_preset else owner_uuid
        if not row_uuid:
            return jsonify({'success': False, 'error': 'Missing uuid'}), 400
        if not data_url.startswith('data:image/'):
            return jsonify({'success': False, 'error': 'Invalid dataUrl image payload'}), 400
        is_round = bool(data.get('isRound'))
        is_bg = 1 if data.get('isBg') in (True, 1, '1', 'true', 'True') else 0
        now = int(time.time() * 1000)
        category = 'presets' if is_preset else 'customs'
        row = {
            'uuid': row_uuid,
            'owner_uuid': owner_uuid if not is_preset else '',
            'shape': 'round' if is_round else 'square',
            'is_bg': is_bg,
            'category': category,
            'created_at': now,
            'r2_key': f'avatars/{row_uuid}/{now}_local_mock.png',
            'dataUrl': data_url,
        }
        _mock_avatar_rows.insert(0, row)
        if len(_mock_avatar_rows) > 200:
            del _mock_avatar_rows[200:]
        return jsonify({
            'success': True,
            **row,
            'media_url': f'http://mock/{row["r2_key"]}',
            'kv_avatar_sync': {'updated': False, 'skipped_reason': 'local_mock'},
        })
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/avatar-list', methods=['GET'])
def avatar_list():
    try:
        category = str(request.args.get('category') or 'customs').strip().lower()
        if category not in ('presets', 'customs'):
            category = 'customs'
        uuid = str(request.args.get('uuid') or '').strip()
        if category == 'customs' and not uuid:
            return jsonify({'success': False, 'error': 'Missing uuid'}), 400
        if category == 'presets':
            avatars = [r for r in _mock_avatar_rows if r.get('category') == 'presets']
        else:
            avatars = [
                r
                for r in _mock_avatar_rows
                if r.get('category') == 'customs' and str(r.get('owner_uuid') or '') == uuid
            ]
        return jsonify({'success': True, 'uuid': uuid, 'category': category, 'avatars': avatars})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/env-check', methods=['GET'])
def env_check():
    return jsonify({
        'success': True,
        'has_my_kv': True,
        'has_avatars_db': True,
        'has_avatars_r2': True,
        'timestamp': int(time.time() * 1000),
    })


def _xrec_server_ping(timeout=1.5):
    try:
        req = urllib.request.Request(f"http://127.0.0.1:{XREC_PORT}/api/ping")
        with urllib.request.urlopen(req, timeout=timeout) as r:
            body = json.loads(r.read().decode("utf-8"))
        return bool(body.get("ok"))
    except Exception:
        return False


def ensure_xrec_server(timeout_sec=10):
    """若 xrec-server 未运行则后台拉起，并等待 /api/ping 就绪。"""
    if _xrec_server_ping():
        return True, "already_running"
    if not os.path.isfile(_XREC_SERVER_SCRIPT):
        return False, "script_missing"
    try:
        subprocess.Popen(
            [sys.executable, _XREC_SERVER_SCRIPT],
            cwd=os.path.dirname(os.path.abspath(__file__)),
        )
    except OSError as e:
        return False, f"spawn_failed:{e}"
    deadline = time.time() + max(2, float(timeout_sec))
    while time.time() < deadline:
        if _xrec_server_ping(timeout=1.0):
            return True, "started"
        time.sleep(0.35)
    return False, "start_timeout"


@app.route("/api/xrec-ensure", methods=["POST"])
def xrec_ensure():
    ok, detail = ensure_xrec_server()
    if ok:
        return jsonify({"ok": True, "detail": detail})
    return jsonify({"ok": False, "error": "xrec-server 启动失败", "detail": detail}), 503


@app.route("/api/xrec-ping")
def xrec_ping():
    """Flask 代理 ping xrec-server，避免浏览器直连 8899 的跨端口/安全策略问题"""
    ok = _xrec_server_ping(timeout=2.0)
    return jsonify({"ok": ok, "server": "xrec-server"})


@app.route("/api/xrec-proxy", defaults={'subpath': ''}, methods=['GET', 'POST', 'OPTIONS'])
@app.route("/api/xrec-proxy/<path:subpath>", methods=['GET', 'POST', 'OPTIONS'])
def xrec_proxy(subpath):
    """Flask 通用代理：将前端请求转发到 xrec-server(8899)，绕开浏览器跨端口限制"""
    target_url = f'http://127.0.0.1:{XREC_PORT}/{subpath}'
    qs = request.query_string
    if qs:
        target_url += '?' + qs.decode('utf-8')
    headers = {}
    content_type = request.content_type
    if content_type:
        headers['Content-Type'] = content_type
    try:
        data = request.get_data()
        req = urllib.request.Request(
            target_url, data=data, headers=headers,
            method=request.method
        )
        with urllib.request.urlopen(req, timeout=30) as resp:
            response_data = resp.read()
            resp_ct = resp.headers.get('Content-Type', 'application/octet-stream')
            status_code = resp.status if hasattr(resp, 'status') else 200
            return Response(response_data, status=status_code, content_type=resp_ct)
    except urllib.error.HTTPError as e:
        return Response(e.read(), status=e.code, content_type='application/json')
    except Exception as e:
        return jsonify({'ok': False, 'error': f'xrec proxy error: {e}'}), 502


@app.route('/api/open-in-chrome', methods=['POST'])
def open_in_chrome():
    """用 Chrome 打开指定 URL（如未安装扩展则回退到此端点手动打开标签页）"""
    data = request.get_json(silent=True) or {}
    url = (data.get('url') or '').strip()
    if not url:
        return jsonify({'success': False, 'error': 'url is required'}), 400
    if not (url.startswith('https://') or url.startswith('http://')):
        return jsonify({'success': False, 'error': 'invalid url'}), 400
    try:
        subprocess.run(['open', '-a', 'Google Chrome', url], check=True, timeout=10)
        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route("/api/xrec-save-data", methods=['POST'])
def xrec_save_data():
    """分步接收 xrec-server 数据：step=partial（fill 前文本+快照）/ step=complete（fill 后视频+截图）"""
    try:
        data = request.get_json(silent=True) or {}
        step = str(data.get('step') or '').strip()
        raw_sid = data.get('session_id') or data.get('sessionId') or ''
        bucket = _xrec_session_bucket(raw_sid)
        norm_sid = _xrec_norm_session_id(raw_sid)
        print(f'[xrec-save] 收到 step={step} raw_sid={str(raw_sid)[:12]} norm_sid={norm_sid}', flush=True)

        if (step === 'partial'):
            doc_text = str(data.get('doc_text_en') or data.get('doc_text') or '').strip()
            tweet_html = str(data.get('tweet_html_inline') or data.get('tweet_html') or '')
            screenshot_b64 = str(data.get('screenshot_b64') or '')
            poster_b64 = str(data.get('poster_b64') or '')
            board_thumb_b64 = str(data.get('board_thumb_b64') or '')
            print(f'[xrec-save] partial step: doc_text_len={len(doc_text)} tweet_html_len={len(tweet_html)}', flush=True)
            post_info_raw = data.get('post_info', '')
            if isinstance(post_info_raw, str) and post_info_raw:
                try:
                    post_info = json.loads(post_info_raw)
                except (ValueError, TypeError):
                    post_info = {}
            else:
                post_info = post_info_raw or {}
            translation = ''
            translation_ok = False
            if doc_text:
                try:
                    translation, translation_ok = _xrec_translate_doc_text(doc_text)
                except Exception as tr_err:
                    print(f'[xrec-save] translation API 失败: {tr_err}', flush=True)
            print(f'[xrec-save] partial translation_len={len(translation)} translation_ok={translation_ok}', flush=True)
            bucket['partial'] = {
                'doc_text': doc_text,
                'translation': translation,
                'tweet_html': tweet_html,
                'screenshot_b64': screenshot_b64,
                'poster_b64': poster_b64,
                'board_thumb_b64': board_thumb_b64,
                'post_info': post_info,
            }
            return jsonify({
                'ok': True,
                'step': 'partial',
                'poster_b64': bool(poster_b64),
                'board_thumb_b64': bool(board_thumb_b64),
            })

        screenshot_b64 = str(data.get('screenshot_b64') or '')
        poster_b64 = str(data.get('poster_b64') or '')
        board_thumb_b64 = str(data.get('board_thumb_b64') or '')
        filename = str(data.get('video_filename') or '').strip()
        partial = bucket.get('partial') or {}
        doc_text = str(partial.get('doc_text') or data.get('doc_text') or '').strip()
        translation = str(partial.get('translation', ''))
        tweet_html = str(partial.get('tweet_html') or data.get('tweet_html') or '')
        post_info = partial.get('post_info', {}) if isinstance(partial.get('post_info'), dict) else {}
        post_info_raw = data.get('post_info', '')
        if isinstance(post_info_raw, str) and post_info_raw:
            try:
                post_info_complete = json.loads(post_info_raw)
            except (ValueError, TypeError):
                post_info_complete = {}
        elif isinstance(post_info_raw, dict):
            post_info_complete = post_info_raw
        else:
            post_info_complete = {}
        if post_info_complete:
            post_info = {**post_info, **post_info_complete}
        if doc_text and not str(translation).strip():
            try:
                translation, translation_ok = _xrec_translate_doc_text(doc_text)
                if translation_ok:
                    print(f'[xrec-save] complete 补译成功 translation_len={len(translation)}', flush=True)
            except Exception as tr_err:
                print(f'[xrec-save] complete 补译失败: {tr_err}', flush=True)
        print(f'[xrec-save] complete step: partial_available={bool(partial)} doc_text_len={len(doc_text)} tweet_html_len={len(tweet_html)} filename={filename} video_size={int(data.get("video_size", 0))}', flush=True)
        if not screenshot_b64 and partial:
            screenshot_b64 = str(partial.get('screenshot_b64', ''))
        if not poster_b64 and partial:
            poster_b64 = str(partial.get('poster_b64', ''))
        if not board_thumb_b64 and partial:
            board_thumb_b64 = str(partial.get('board_thumb_b64', ''))
        bucket['last_collect'] = {
            'filename': filename,
            'video_size': int(data.get('video_size', 0)),
            'doc_text': doc_text,
            'translation': translation,
            'composer_text': (translation or doc_text).strip(),
            'screenshot_b64': screenshot_b64,
            'poster_b64': poster_b64,
            'board_thumb_b64': board_thumb_b64,
            'post_info': post_info,
            'tweet_html': tweet_html,
        }
        bucket['partial'] = {}
        return jsonify({
            'ok': True,
            'filename': filename,
            'doc_text': doc_text,
            'translation': translation,
            'screenshot_b64': bool(screenshot_b64),
            'poster_b64': bool(poster_b64),
            'board_thumb_b64': bool(board_thumb_b64),
        })
    except Exception as e:
        print(f"[xrec-save] 处理异常: {e}", flush=True)
        return jsonify({'ok': False, 'error': str(e)}), 500


@app.route("/api/xrec-last-collect", methods=['GET'])
def xrec_last_collect():
    """前端轮询拉取最后的采集结果（翻译文本、截屏、视屏文件名）
    Phase 2: 本机无数据时 fallback 到 CF KV（extension 直传 CF）"""
    sid = request.args.get('session_id') or request.args.get('sessionId')
    bucket = _xrec_session_bucket(sid)
    data = bucket.get('last_collect')
    if data:
        return jsonify({'ok': True, 'data': data})

    # 本机无数据 → fallback 到 CF KV
    try:
        cf_url = f'https://l-eng-pages2.pages.dev/api/xrec-last-collect?session_id={urllib.parse.quote(sid)}'
        req = urllib.request.Request(cf_url, method='GET')
        with _https_urlopen(req, timeout=10) as r:
            cf_data = json.loads(r.read().decode('utf-8') or '{}')
        if cf_data.get('ok') and cf_data.get('data'):
            return jsonify(cf_data)
    except Exception as e:
        print(f'[xrec-last-collect] CF fallback failed: {e}', flush=True)

    return jsonify({'ok': False, 'error': '还没有采集数据'})


@app.route("/api/xrec-partial", methods=['GET'])
def xrec_partial():
    """fill 后、Send 前：拉取 partial 阶段的译文与 video 尺寸
    Phase 2: 本机无数据时 fallback 到 CF KV"""
    sid = request.args.get('session_id') or request.args.get('sessionId')
    bucket = _xrec_session_bucket(sid)
    partial = bucket.get('partial') or {}
    if partial:
        return jsonify({'ok': True, 'data': partial})

    # 本机无数据 → fallback 到 CF KV
    try:
        cf_url = f'https://l-eng-pages2.pages.dev/api/xrec-last-collect?session_id={urllib.parse.quote(sid)}'
        req = urllib.request.Request(cf_url, method='GET')
        with _https_urlopen(req, timeout=10) as r:
            cf_data = json.loads(r.read().decode('utf-8') or '{}')
        if cf_data.get('ok') and cf_data.get('data'):
            d = cf_data['data']
            return jsonify({'ok': True, 'data': {
                'doc_text': d.get('doc_text', ''),
                'translation': d.get('translation', ''),
                'screenshot_b64': d.get('screenshot_b64', ''),
                'post_info': d.get('post_info', {}),
                'tweet_html': d.get('tweet_html', ''),
            }})
    except Exception as e:
        print(f'[xrec-partial] CF fallback failed: {e}', flush=True)

    return jsonify({'ok': False, 'error': 'partial 尚未就绪'})


@app.route("/api/xrec-reset-session", methods=['POST'])
def xrec_reset_session():
    """新开录制前清空 partial / 上次 collect，避免主站误显旧数据"""
    data = request.get_json(silent=True) or {}
    sid = data.get('session_id') or data.get('sessionId')
    bucket = _xrec_session_bucket(sid)
    bucket['last_collect'] = None
    bucket['partial'] = {}
    return jsonify({'ok': True})


@app.route("/api/x-import", methods=['POST'])
def x_import_local():
    """本地 x-import：默认代理 hobby-era 线上 API，与生产判定一致；失败时才 mock。"""
    try:
        data = request.get_json(silent=True) or {}
        x_url = str(data.get('x_url') or data.get('url') or '').strip()
        if not x_url:
            return jsonify({'success': False, 'error': 'Missing x_url'}), 400

        upstream = os.environ.get(
            'X_IMPORT_UPSTREAM', 'https://hobby-era.com/api/x-import'
        ).strip()
        if upstream:
            try:
                payload = json.dumps({'url': x_url, 'x_url': x_url}).encode('utf-8')
                req = urllib.request.Request(
                    upstream,
                    data=payload,
                    headers={'Content-Type': 'application/json'},
                    method='POST',
                )
                with _https_urlopen(req, timeout=45) as r:
                    body = json.loads(r.read().decode('utf-8') or '{}')
                if body.get('success'):
                    # 清理上游返回文本中的 pic.twitter.com / t.co 短链
                    q = body.get('quote') or {}
                    if q.get('text'):
                        q['text'] = re.sub(r'\s*(?:https?://)?(t\.co|pic\.twitter\.com)/\S+', '', q['text']).strip()
                    print(f'[x-import] upstream ok url={x_url[:80]}', flush=True)
                    return jsonify(body)
                print(f'[x-import] upstream not success: {body.get("error")}', flush=True)
            except Exception as e:
                print(f'[x-import] upstream failed ({upstream}): {e}', flush=True)

        warnings = []
        try:
            quote = _x_import_via_oembed_and_page(x_url, warnings)
            print(
                f'[x-import] local oembed+page ok media={len(quote.get("media") or [])} '
                f'needs_xrec={quote.get("needs_xrec")} url={x_url[:80]}',
                flush=True,
            )
            return jsonify({
                'success': True,
                'mode': 'fallback',
                'quote': quote,
                'media_report': quote['media_report'],
                'warnings': warnings,
            })
        except Exception as e:
            print(f'[x-import] local oembed+page failed: {e}', flush=True)
            warnings.append(f'本地 oEmbed 失败: {e}')

        # 最后兜底：不触发 xrec 的空 mock
        status_id = _x_import_status_id(x_url) or '0'
        quote = {
            'mode': 'fallback',
            'source_url': x_url,
            'status_id': status_id,
            'author_name': '',
            'author_handle': '',
            'text': '',
            'source_label': '来源：X',
            'fetched_at': int(time.time() * 1000),
            'media': [],
            'media_report': {
                'strategy': 'oembed_local_mock',
                'source': {'official_api_used': False, 'oembed_ok': False, 'open_graph_ok': False},
                'media': {'fetched_count': 0, 'r2_stored_count': 0, 'fallback_count': 0},
                'final_tier': 'no_media',
                'embed_tweet': False,
            },
            'has_full_content': False,
            'embed_tweet': False,
            'prefer_embed': True,
            'needs_xrec': False,
        }
        if os.environ.get('X_IMPORT_MOCK_VIDEO', '').strip() in ('1', 'true', 'yes'):
            quote['media'] = [{
                'type': 'video',
                'origin_url': 'https://video.twimg.com/ext_tw_video/123456789/pu/vid/avc1/720x1280.mp4',
                'preview_url': 'https://pbs.twimg.com/ext_tw_video_thumb/123456789/pu/img/abc123.jpg',
            }]
            quote['needs_xrec'] = True
            warnings.append('X_IMPORT_MOCK_VIDEO=1 离线视频 mock')
        return jsonify({
            'success': True,
            'mode': 'fallback',
            'quote': quote,
            'media_report': quote['media_report'],
            'warnings': warnings,
        })
    except Exception as e:
        print(f"x-import 错误: {e}")
        return jsonify({'success': False, 'error': str(e or '导入失败')}), 500


# ========== Chrome Extension 视频上传（已弃用，extension 现直传 CF Functions → R2）==========
# 保留作为本地调试降级方案
@app.route("/api/xrec-video-save", methods=['POST'])
def xrec_video_save():
    """[DEPRECATED] 接收 Chrome Extension 上传的视频文件，保存到 ~/Movies/XRec/，转码
    Phase 2 之后 extension 直接 POST multipart 到 CF /api/xrec-video-upload → R2。"""
    try:
        if 'video' not in request.files:
            return jsonify({'ok': False, 'error': 'no video file'}), 400
        f = request.files['video']
        filename = f.filename or 'xrec_recording.webm'
        session_id = (request.form.get('session_id') or '').strip()

        # 安全处理文件名
        safe_name = re.sub(r'[^a-zA-Z0-9._-]', '_', filename)
        movie_dir = os.path.expanduser('~/Movies/XRec')
        os.makedirs(movie_dir, exist_ok=True)
        webm_path = os.path.join(movie_dir, safe_name)
        f.save(webm_path)
        file_size = os.path.getsize(webm_path)

        print(f'[xrec-video] 收到视频 {safe_name} size={file_size} session={session_id[:8] if session_id else "?"}',
              flush=True)

        # 视频元信息
        video_width = int(request.form.get('video_width', 0))
        video_height = int(request.form.get('video_height', 0))
        orientation = request.form.get('orientation', '').strip()

        # 转码 webm → mp4
        mp4_name = safe_name
        if mp4_name.endswith('.webm'):
            mp4_name = mp4_name[:-5] + '.mp4'
        mp4_path = os.path.join(movie_dir, mp4_name)
        try:
            subprocess.run(
                ['ffmpeg', '-y', '-i', webm_path,
                 '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
                 '-c:a', 'aac', '-b:a', '128k',
                 '-movflags', '+faststart', mp4_path],
                check=True, capture_output=True, timeout=120
            )
            mp4_size = os.path.getsize(mp4_path)
            print(f'[xrec-video] 转码完成 {mp4_name} size={mp4_size}', flush=True)
        except Exception as transcode_err:
            print(f'[xrec-video] 转码失败，保留 webm: {transcode_err}', flush=True)
            mp4_name = safe_name
            mp4_path = webm_path

        return jsonify({
            'ok': True,
            'filename': mp4_name,
            'size': file_size,
            'video_width': video_width,
            'video_height': video_height,
            'orientation': orientation,
        })
    except Exception as e:
        print(f'[xrec-video] 保存失败: {e}', flush=True)
        return jsonify({'ok': False, 'error': str(e)}), 500


@app.route("/api/translate-text", methods=['POST'])
def api_translate_text():
    """翻译文本为简体中文：OpenAI → Gemini → Google 翻译"""
    try:
        data = request.get_json(silent=True) or {}
        text = (data.get('text') or '').strip()
        target = (data.get('target') or 'zh-CN').strip()
        print(f'[translate-text] request text_len={len(text)} target={target}', flush=True)
        if not text:
            return jsonify({'success': False, 'error': '没有要翻译的文字'})

        # 1. OpenAI
        openai_key = os.environ.get('OPENAI_API_KEY', '').strip()
        if openai_key:
            try:
                translated = _translate_with_openai(text, openai_key)
                if translated:
                    return jsonify({'success': True, 'translated_text': translated, 'mode': 'openai'})
            except Exception as e_open:
                print(f'[translate-text] OpenAI failed: {e_open}', flush=True)

        # 2. Gemini
        gemini_key = os.environ.get('GEMINI_API_KEY', '').strip()
        if gemini_key:
            try:
                translated = _translate_with_gemini(text, gemini_key)
                if translated:
                    return jsonify({'success': True, 'translated_text': translated, 'mode': 'gemini'})
            except Exception as e_gem:
                print(f'[translate-text] Gemini failed: {e_gem}', flush=True)

        # 3. Google 翻译（免费）
        translated = _translate_with_google(text, target)
        if translated:
            return jsonify({'success': True, 'translated_text': translated, 'mode': 'google'})
        return jsonify({'success': False, 'error': '翻译结果为空'})
    except Exception as e:
        print(f'[translate-text] error: {e}', flush=True)
        return jsonify({'success': False, 'error': str(e)})


def _translate_with_openai(text, key):
    base = os.environ.get('OPENAI_API_BASE', 'https://api.openai.com/v1').rstrip('/')
    model = os.environ.get('OPENAI_TRANSLATE_MODEL', 'gpt-4o-mini').strip() or 'gpt-4o-mini'
    body = {
        'model': model,
        'temperature': 0.2,
        'messages': [
            {'role': 'system',
             'content': 'You translate social media post text into natural Simplified Chinese. '
                        'Preserve meaningful line breaks. Output only the translation, no quotes or preamble.'},
            {'role': 'user', 'content': text}
        ]
    }
    req = urllib.request.Request(
        f'{base}/chat/completions',
        data=json.dumps(body).encode('utf-8'),
        headers={
            'Authorization': f'Bearer {key}',
            'Content-Type': 'application/json'
        }
    )
    with _https_urlopen(req, timeout=30) as resp:
        payload = json.loads(resp.read().decode('utf-8'))
    choice = (payload.get('choices') or [{}])[0]
    out = (choice.get('message') or {}).get('content', '')
    return (out or '').strip() or ''


def _translate_with_gemini(text, key):
    base = os.environ.get('GEMINI_API_BASE', 'https://generativelanguage.googleapis.com/v1beta').rstrip('/')
    model = os.environ.get('GEMINI_TRANSLATE_MODEL', 'gemini-2.5-flash').strip() or 'gemini-2.5-flash'
    system_text = ('You translate social media post text into natural Simplified Chinese. '
                   'Preserve meaningful line breaks. Output only the translation, no quotes or preamble.')
    url = f'{base}/models/{urllib.parse.quote(model)}:generateContent?key={urllib.parse.quote(key)}'
    body = {
        'systemInstruction': {'parts': [{'text': system_text}]},
        'contents': [{'role': 'user', 'parts': [{'text': text}]}],
        'generationConfig': {'temperature': 0.2, 'maxOutputTokens': 8192}
    }
    req = urllib.request.Request(
        url,
        data=json.dumps(body).encode('utf-8'),
        headers={'Content-Type': 'application/json'}
    )
    with _https_urlopen(req, timeout=30) as resp:
        payload = json.loads(resp.read().decode('utf-8'))
    cand = (payload.get('candidates') or [{}])[0]
    parts = (cand.get('content') or {}).get('parts') or []
    out = ''.join(p.get('text', '') for p in parts if isinstance(p, dict))
    return (out or '').strip() or ''


def _translate_with_google(text, target):
    encoded = urllib.parse.quote(text)
    url = f'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl={target}&dt=t&q={encoded}'
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    with _https_urlopen(req, timeout=15) as resp:
        result = json.loads(resp.read().decode('utf-8'))
    sentences = []
    for block in (result[0] if isinstance(result, list) and len(result) > 0 else []):
        if block and isinstance(block, list) and len(block) > 0 and block[0]:
            sentences.append(str(block[0]))
    return ''.join(sentences).strip() or ''


@app.route("/")
def home():
    try:
        with open('public/index.html', 'r', encoding='utf-8') as f:
            return f.read()
    except FileNotFoundError:
        return "index.html not found", 404


@app.route("/test_env_switch.html")
def test_env_switch_page():
    """开发用环境切换测试页（注册面板调试条中的链接）"""
    try:
        with open('test_env_switch.html', 'r', encoding='utf-8') as f:
            return f.read()
    except FileNotFoundError:
        return "test_env_switch.html not found", 404



if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description='启动Flask服务器')
    parser.add_argument('--port', type=int, default=5001, help='服务器端口号')
    parser.add_argument('--with-xrec', action='store_true', help='同时启动 xrec-server.py（已由 Chrome Extension 替代）')
    args = parser.parse_args()

    port = args.port
    lan_ip = get_local_ip()

    if args.with_xrec:
        xrec_ok, xrec_detail = ensure_xrec_server()
        if xrec_ok:
            print(f"xrec-server: 就绪 ({xrec_detail}) script={_XREC_SERVER_SCRIPT} http://127.0.0.1:{XREC_PORT}")
        else:
            print(f"xrec-server: 未就绪 ({xrec_detail})，导入 X 视频帖时将尝试再次拉起")
    else:
        print(f"xrec-server: 未启动（使用 Chrome Extension 替代）")

    print(f"本地访问: http://127.0.0.1:{port}")
    print(f"局域网访问: http://{lan_ip}:{port}")
    print("请确保手机和电脑在同一WiFi网络下")
    if lan_ip == "127.0.0.1":
        print("提示：未探测到局域网 IPv4，请检查网络；或用本机实际局域网 IP 手动访问。")
    app.run(debug=True, use_reloader=False, host='0.0.0.0', port=port)


