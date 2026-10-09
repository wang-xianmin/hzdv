#!/usr/bin/env python3
import os, sys, json, time, hashlib, traceback, io
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import urllib.request

LOGDIR = "/root/hzdv/services/pose/logs"
os.makedirs(LOGDIR, exist_ok=True)
JSONL = os.path.join(LOGDIR, "proxy_reqs.jsonl")
ORIGIN = "http://127.0.0.1:18093"  # 我们把原容器改成映射 18093->8093，proxy 就监听 8093 对外，不用改 Pages env！

import numpy as np
import cv2
import onnxruntime as ort

MODEL_PATH = "/root/hzdv/services/pose/models/active.onnx"
SESS_OPTS = ort.SessionOptions()
SESS_OPTS.log_severity_level = 3
SESS = ort.InferenceSession(MODEL_PATH, sess_options=SESS_OPTS, providers=["CPUExecutionProvider"])
IN_NAME = SESS.get_inputs()[0].name
IN_SHAPE = SESS.get_inputs()[0].shape
OUT_NAME = SESS.get_outputs()[0].name
IMGSZ = int(IN_SHAPE[2]) if isinstance(IN_SHAPE[2], int) else 416
print("PROXY LOADED", IN_NAME, IN_SHAPE, "UPSTREAM:", ORIGIN)

def letterbox(im, sz=416):
    h,w = im.shape[:2]
    s = sz/max(h,w)
    nh,nw = int(h*s), int(w*s)
    r = cv2.resize(im, (nw,nh), interpolation=cv2.INTER_AREA)
    padh,padw = sz-nh, sz-nw
    top,left = padh//2, padw//2
    out = np.full((sz,sz,3), 114, dtype=np.uint8)
    out[top:top+nh, left:left+nw] = r
    return out

def run_onnx_raw(file_bytes):
    try:
        arr = np.frombuffer(file_bytes, dtype=np.uint8)
        im = cv2.imdecode(arr, 1)
        if im is None: return {"imdecode_fail": True}
        lb = letterbox(im, IMGSZ)
        inp = lb[:,:,::-1].transpose(2,0,1)[None,...].astype(np.float32)/255.0
        pred = SESS.run([OUT_NAME], {IN_NAME:inp})[0][0]
        if pred.ndim == 3: pred = pred[0]
        rec = {"onnx_shape": list(pred.shape)}
        if pred.ndim==2 and pred.shape[0]>=5 and pred.shape[1]>0:
            obj = pred[4,:]
            rec["onnx_obj_conf_max"] = float(obj.max())
            imax = int(np.argmax(obj))
            kconfs = []
            for i in range(4):
                cidx = 5 + 3*i + 2
                kconfs.append(float(pred[cidx, imax]) if cidx < pred.shape[0] else None)
            rec["onnx_kpt_conf_at_argmax"] = kconfs
            rec["onnx_pred_xywh_argmax"] = [float(pred[j,imax]) for j in range(4)]
        return rec
    except Exception as e:
        return {"onnx_err": str(e)[:200], "tb": traceback.format_exc()[:500]}

def extract_file_from_multipart(raw_bytes, ctype):
    try:
        if ctype and "boundary=" in ctype:
            sep = ("--" + ctype.split("boundary=")[1].split(";")[0].strip()).encode()
            parts = raw_bytes.split(sep)
            for p in parts:
                if b"filename=" in p[:800]:
                    he = p.find(b"\r\n\r\n")
                    if he > 0:
                        body = p[he+4:]
                        if body.endswith(b"\r\n"): body = body[:-2]
                        if body.endswith(b"--"): body = body[:-2]
                        return bytes(body)
    except Exception:
        pass
    return None

def extract_file_from_json(raw_bytes):
    try:
        d = json.loads(raw_bytes.decode("utf-8","ignore"))
        if isinstance(d, dict):
            import base64
            b64 = d.get("image") or d.get("img") or ""
            if isinstance(b64,str) and "," in b64: b64 = b64.split(",",1)[1]
            if isinstance(b64,str):
                return base64.b64decode(b64 + "===", validate=False)
    except Exception:
        pass
    return None

class H(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        try: sys.stderr.write("[%s] %s\n" % (self.log_date_time_string(), fmt % args))
        except Exception: pass
    def do_GET(self):
        if self.path in ("/health","/healthz"):
            self._proxy(None, b"", 0, None, None, {})
            return
        self.send_response(200); self.send_header("Content-Type","application/json"); self.end_headers()
        self.wfile.write(json.dumps({"debug_proxy":True,"upstream":ORIGIN}).encode())
    def do_POST(self):
        length = int(self.headers.get("Content-Length","0") or 0)
        raw = self.rfile.read(length) if length > 0 else b""
        ctype = self.headers.get("Content-Type","") or ""
        file_bytes = None
        if "multipart/form-data" in ctype:
            file_bytes = extract_file_from_multipart(raw, ctype)
        elif "application/json" in ctype:
            file_bytes = extract_file_from_json(raw)
        ts = int(time.time()*1000)
        img_path = None
        if isinstance(file_bytes,(bytes,bytearray)) and len(file_bytes) >= 4096:
            try:
                h = hashlib.sha1(file_bytes[:65536]).hexdigest()[:12]
                ext = "jpg" if file_bytes[:3]==b"\xff\xd8\xff" else ("png" if file_bytes[:8]==b"\x89PNG\r\n\x1a\n" else "bin")
                img_path = os.path.join(LOGDIR, "req_%d_%s.%s" % (ts, h, ext))
                open(img_path,"wb").write(file_bytes)
            except Exception: pass
        onnx_rec = run_onnx_raw(file_bytes) if file_bytes else {}
        self._proxy(ctype, raw, ts, len(file_bytes) if isinstance(file_bytes,(bytes,bytearray)) else None, img_path, onnx_rec)
    def _proxy(self, ctype, raw, ts, fb_len, img_path, onnx_rec):
        try:
            url = ORIGIN + self.path
            req = urllib.request.Request(url, data=raw or b"", method=self.command)
            for k,v in self.headers.items():
                if k.lower() not in ("host","content-length"):
                    req.add_header(k, v)
            if ctype: req.add_header("Content-Type", ctype)
            t0 = time.time()
            status = 502; data = b'{"success":false,"error":"upstream_fail"}'; headers = {}
            try:
                with urllib.request.urlopen(req, timeout=90) as resp:
                    status = resp.status; data = resp.read(); headers = resp.headers
            except urllib.error.HTTPError as he:
                status = he.code; data = he.read(); headers = he.headers
            except Exception as ee:
                status = 502; data = json.dumps({"success":False,"error":"upstream_err:"+str(ee)}).encode()
            origin_elapsed = round(time.time()-t0, 4)
            origin_summary = {"status":status,"elapsed_sec":origin_elapsed,"ctype":headers.get("Content-Type","")}
            try:
                d = json.loads(data.decode("utf-8","ignore"))
                origin_summary["person_count"] = d.get("person_count")
                origin_summary["success"] = d.get("success")
                imgsz = d.get("image_size") or None
                iw = ih = None
                if isinstance(imgsz, dict):
                    if "width" in imgsz and "height" in imgsz:
                        iw = int(imgsz["width"]); ih = int(imgsz["height"])
                    elif "w" in imgsz and "h" in imgsz:
                        iw = int(imgsz["w"]); ih = int(imgsz["h"])
                elif isinstance(imgsz,(list,tuple)) and len(imgsz) >= 2:
                    iw = int(imgsz[0]); ih = int(imgsz[1])
                if iw is not None and ih is not None:
                    origin_summary["image_size"] = [iw, ih]
                else:
                    iw = ih = None
                labelOrder = ["TL","TR","BR","BL"]
                persons = d.get("persons") or []
                cands = []
                for idx, pp in enumerate(persons):
                    kps = pp.get("keypoints") or []
                    pbox = pp.get("box") or []
                    pbox4 = pbox[:4] if len(pbox) >= 4 else None
                    for i in range(min(4, len(kps))):
                        k = kps[i]
                        if isinstance(k, dict):
                            x = k.get("x"); y = k.get("y")
                            cf = k.get("conf") or k.get("confidence") or 0.0
                        elif isinstance(k, list) and len(k) >= 3:
                            x = k[0]; y = k[1]; cf = float(k[2] or 0.0)
                        else:
                            continue
                        if x is None or y is None or not isinstance(cf,(int,float)): continue
                        if isinstance(imgsz,(list,tuple)) and len(imgsz) >= 2:
                            if not (0 <= float(x) <= float(imgsz[0]) and 0 <= float(y) <= float(imgsz[1])): continue
                        cands.append({"x":float(x),"y":float(y),"c":float(cf),"pi":idx,"ki":i,"box":pbox4})
                origin_summary["cand_count"] = len(cands)
                MIN_C = 0.005
                good = [cc for cc in cands if cc["c"] >= MIN_C]
                if good: cands = good
                # --- proxy v6i: 比例模式校准（修复固定dy绝对值跨扫图不通用）
                # 根因实锤：不同扫图raw TL y在127~969波动（差842px整图44%），固定dy=-510会下一张顶飞出clamp0
                # v6i策略：y轴以BR/BL y为稳定锚点（仅波动66px/3.5%），TopY=BottomY - W_raw*1.414(A4比例)
                #        x轴按W_raw百分比扩宽（不依赖绝对dx，W_raw 517~610波动时也通用）
                # 默认模式=ratio；如果query传老格式?calib=TL:dx,dy...仍走abs兼容。
                MAX_PAPER_TOP_Y_FRAC = 0.35
                MIN_PAPER_BOT_Y_FRAC = 0.60
                MIN_PAPER_W_FRAC = 0.50
                MIN_PAPER_H_FRAC = 0.50
                EXPAND_DELTA_PCT = 0.00
                STAGE3_CONF = 0.50
                STAGE1_ACCEPT_CONF_AVG = 0.30
                STAGE3_YBOT_KP_MIN_CONF = 0.15
                CALIBRATION_ENABLE = True
                CALIBRATION_MODE = "ratio"  # "ratio" or "abs"
                # v6i 默认比例参数（6张真实扫图验证通用）
                CALIB_RATIO = {
                    "LEFT_EXPAND_PCT":  0.14,  # TL/BL x相对W_raw再往左扩14%
                    "RIGHT_EXPAND_PCT": 0.13,  # TR/BR x相对W_raw再往右扩13%
                    "TOP_EXTRA_PCT":    0.035, # TopY除了PaperH还多往上顶3.5% PaperH（顶边纸留白）
                    "BOT_SHRINK_PCT":   0.025, # BottomY比raw BR/BL再上缩2.5% W（底不贴边）
                    "A4_RATIO":         1.4142,# H/W=√2
                }
                # v6h绝对校准：兼容老前端query calib格式
                CALIBRATION_V6E_ABS = {
                    "TL": {"dx": -110, "dy": -510},
                    "TR": {"dx":   10, "dy": -510},
                    "BR": {"dx":  -20, "dy": -350},
                    "BL": {"dx":  -90, "dy": -350},
                }
                CALIBRATION_V6E = dict(CALIBRATION_V6E_ABS)
                # --- v6i 扩展query解析：新格式?calib_mode=ratio&left=0.14&right=0.13&top=0.035&bot=0.025
                try:
                    raw_path = getattr(self, "path", "") or ""
                    _query = ""
                    if "?" in raw_path:
                        _query = raw_path.split("?",1)[1]
                    import urllib.parse as _uparse
                    _qs = _uparse.parse_qs(_query)
                    def _f(x,d=0.0):
                        try: return float(x)
                        except Exception: return d
                    _mode = ((_qs.get("calib_mode") or [""])[0]).strip().lower()
                    _left = _f((_qs.get("left") or ["0.0"])[0])
                    _right= _f((_qs.get("right") or ["0.0"])[0])
                    _top  = _f((_qs.get("top") or ["0.0"])[0])
                    _bot  = _f((_qs.get("bot") or ["0.0"])[0])
                    _ratio = ((_qs.get("a4ratio") or ["0.0"])[0]).strip()
                    # 老格式abs优先覆盖
                    _calib_str = ((_qs.get("calib") or [""])[0]).strip()
                    if _calib_str:
                        _override = {}
                        for _seg in _calib_str.split(";"):
                            _seg = _seg.strip()
                            if not _seg or ":" not in _seg: continue
                            _lbl, _nums = _seg.split(":",1)
                            _lbl = _lbl.upper().strip()
                            if _lbl not in ("TL","TR","BR","BL"): continue
                            _parts = [p.strip() for p in _nums.split(",") if p.strip()]
                            if len(_parts) >= 2:
                                try:
                                    _override[_lbl] = {"dx":float(_parts[0]), "dy":float(_parts[1])}
                                except Exception: pass
                        if len(_override) == 4:
                            CALIBRATION_MODE = "abs"
                            CALIBRATION_V6E = _override
                            origin_summary["calibration_override_from_query"] = _override
                            origin_summary["calibration_mode"] = "abs_override"
                    elif _mode in ("ratio","r","percent","pct"):
                        CALIBRATION_MODE = "ratio"
                        CALIB_RATIO["LEFT_EXPAND_PCT"]  = _left if _left > 0 else CALIB_RATIO["LEFT_EXPAND_PCT"]
                        CALIB_RATIO["RIGHT_EXPAND_PCT"] = _right if _right > 0 else CALIB_RATIO["RIGHT_EXPAND_PCT"]
                        CALIB_RATIO["TOP_EXTRA_PCT"]    = _top if _top != 0 else CALIB_RATIO["TOP_EXTRA_PCT"]
                        CALIB_RATIO["BOT_SHRINK_PCT"]   = _bot if _bot != 0 else CALIB_RATIO["BOT_SHRINK_PCT"]
                        if _ratio:
                            try: CALIB_RATIO["A4_RATIO"] = float(_ratio)
                            except Exception: pass
                        origin_summary["calibration_mode"] = "ratio"
                        origin_summary["calibration_ratio_params"] = dict(CALIB_RATIO)
                    else:
                        # 默认ratio
                        origin_summary["calibration_mode"] = "ratio_default"
                        origin_summary["calibration_ratio_params"] = dict(CALIB_RATIO)
                except Exception as _e:
                    origin_summary["calib_parse_error"] = str(_e)[:120]
                selected = {"TL":None,"TR":None,"BR":None,"BL":None}
                selection_stage = "none"

                def _pick_extremes_4(pool):
                    """TL=min(x+y), TR=max(x-y), BR=max(x+y), BL=min(x-y)."""
                    if not pool or len(pool) < 4: return None
                    try:
                        import numpy as np
                        arr = np.array([[float(c["x"]), float(c["y"])] for c in pool], dtype=np.float64)
                        xs, ys = arr[:,0], arr[:,1]
                        s = xs + ys; d = xs - ys
                        idx = {
                            "TL": int(np.argmin(s)),
                            "TR": int(np.argmax(d)),
                            "BR": int(np.argmax(s)),
                            "BL": int(np.argmin(d)),
                        }
                    except Exception:
                        from functools import cmp_to_key
                        def _argmin(lst, key_fn):
                            best_i=0; best_v=key_fn(lst[0])
                            for i in range(1,len(lst)):
                                v=key_fn(lst[i])
                                if v<best_v: best_v=v; best_i=i
                            return best_i
                        def _argmax(lst, key_fn):
                            best_i=0; best_v=key_fn(lst[0])
                            for i in range(1,len(lst)):
                                v=key_fn(lst[i])
                                if v>best_v: best_v=v; best_i=i
                            return best_i
                        pool_list = list(pool)
                        idx = {
                            "TL": _argmin(pool_list, lambda c: c["x"]+c["y"]),
                            "TR": _argmax(pool_list, lambda c: c["x"]-c["y"]),
                            "BR": _argmax(pool_list, lambda c: c["x"]+c["y"]),
                            "BL": _argmin(pool_list, lambda c: c["x"]-c["y"]),
                        }
                    picked = {}
                    used = set()
                    for lbl, pool_i in idx.items():
                        if pool_i not in used:
                            picked[lbl] = dict(pool[pool_i])
                            used.add(pool_i)
                    if len(picked) < 4:
                        for lbl in ("TL","TR","BR","BL"):
                            if lbl in picked: continue
                            for j in range(len(pool)):
                                if j not in used:
                                    picked[lbl] = dict(pool[j]); used.add(j); break
                    return picked if len(picked)==4 else None

                def _range_ok(quad):
                    if not quad or iw is None or ih is None: return False
                    try:
                        TL, TR, BR, BL = quad["TL"], quad["TR"], quad["BR"], quad["BL"]
                        top_y = min(TL["y"], TR["y"])
                        bot_y = max(BL["y"], BR["y"])
                        left_x = min(TL["x"], BL["x"])
                        right_x = max(TR["x"], BR["x"])
                        W, H = right_x - left_x, bot_y - top_y
                        return (top_y < MAX_PAPER_TOP_Y_FRAC*ih
                                and bot_y > MIN_PAPER_BOT_Y_FRAC*ih
                                and W > MIN_PAPER_W_FRAC*iw
                                and H > MIN_PAPER_H_FRAC*ih)
                    except Exception:
                        return False

                def _quad_to_selected(quad):
                    out = {}
                    for lbl in ("TL","TR","BR","BL"):
                        v = quad.get(lbl)
                        if isinstance(v, dict):
                            out[lbl] = {"x": float(v["x"]), "y": float(v["y"]),
                                        "c": float(v.get("c") or v.get("conf") or 0.0),
                                        "pi": int(v.get("pi",-1)), "ki": int(v.get("ki",-99))}
                    return out

                # --- Stage 1: kp extremes from cands (高conf直出，不管range_ok) ---
                q1 = _pick_extremes_4(cands)
                stage1_accept_by_conf = False
                if q1:
                    q1_confs = [q1[lbl].get("c", 0.0) for lbl in ("TL","TR","BR","BL") if q1.get(lbl)]
                    q1_avg_conf = sum(q1_confs)/len(q1_confs) if q1_confs else 0.0
                    origin_summary["stage1_avg_conf"] = round(q1_avg_conf, 4)
                    if _range_ok(q1):
                        selected = _quad_to_selected(q1); selection_stage = "1_kp_extremes"
                        origin_summary["range_pass_stage1"] = True
                    elif q1_avg_conf >= STAGE1_ACCEPT_CONF_AVG:
                        # v6d: 4角平均conf够高，哪怕range不ok（top偏下/窄）也直出，等用户肉眼给校准量
                        selected = _quad_to_selected(q1); selection_stage = "1_kp_extremes_hi_conf"
                        stage1_accept_by_conf = True
                        origin_summary["range_pass_stage1"] = False
                        origin_summary["stage1_accept_hi_conf"] = True
                    else:
                        origin_summary["range_pass_stage1"] = False
                else:
                    origin_summary["range_pass_stage1"] = False

                if not any(selected.values()):
                    # --- Stage 2: + box synthetic corners ---
                    boxes = []; max_score = 0.0
                    for idx, pp in enumerate(persons):
                        sc = float(pp.get("score") or 0.0); max_score = max(max_score, sc)
                        box = pp.get("box") or []
                        if len(box) >= 4:
                            x1,y1,x2,y2 = [float(v) for v in box[:4]]
                            if iw is not None and ih is not None:
                                x1 = max(0.0,min(iw-1.0,x1)); y1 = max(0.0,min(ih-1.0,y1))
                                x2 = max(0.0,min(iw-1.0,x2)); y2 = max(0.0,min(ih-1.0,y2))
                            if (x2-x1)>=30 and (y2-y1)>=30:
                                boxes.append(dict(pi=idx,x1=x1,y1=y1,x2=x2,y2=y2))
                    if boxes:
                        synth_c = max(STAGE3_CONF * 0.6, max_score * 0.9, 0.30)
                        synth_cands = list(cands)
                        base_ki = 3000
                        for bb in boxes:
                            for name, cx, cy in [("TL",bb["x1"],bb["y1"]),("TR",bb["x2"],bb["y1"]),
                                                  ("BR",bb["x2"],bb["y2"]),("BL",bb["x1"],bb["y2"])]:
                                synth_cands.append(dict(x=float(cx),y=float(cy),c=float(synth_c),
                                                        pi=int(bb["pi"]),ki=base_ki,box=None))
                                base_ki += 1
                        q2 = _pick_extremes_4(synth_cands)
                        if q2 and _range_ok(q2):
                            selected = _quad_to_selected(q2); selection_stage = "2_box_synth"
                            origin_summary["range_pass_stage2"] = True
                        else:
                            origin_summary["range_pass_stage2"] = False
                            # --- Stage 3: A4 geometric solve (反推top) ---
                            try:
                                import math
                                bx1s = [b["x1"] for b in boxes]
                                bx2s = [b["x2"] for b in boxes]
                                by2s = [b["y2"] for b in boxes]
                                X_left_raw = min(bx1s); X_right_raw = max(bx2s)
                                W_raw = X_right_raw - X_left_raw
                                delta = W_raw * EXPAND_DELTA_PCT
                                X_left = X_left_raw - delta
                                X_right = X_right_raw + delta
                                if iw is not None:
                                    X_left = max(0.0, min(iw-1.0, X_left))
                                    X_right = max(0.0, min(iw-1.0, X_right))
                                # v6d: Y_bot不再取box max y2(会拿到桌面1919)，取kp中conf>=STAGE3_YBOT_KP_MIN_CONF的下两角median
                                bottom_y_cands = []
                                for cc in cands:
                                    try:
                                        if cc["c"] >= STAGE3_YBOT_KP_MIN_CONF and cc["y"] > 0.55 * ih:
                                            bottom_y_cands.append(float(cc["y"]))
                                    except Exception: pass
                                if bottom_y_cands:
                                    sorted_b = sorted(bottom_y_cands)
                                    Y_bot = sorted_b[len(sorted_b)//2]
                                else:
                                    Y_bot = max(by2s)
                                # 再和box y2的中位数结合，避免飘太高
                                sorted_by2 = sorted(by2s)
                                box_by2_med = sorted_by2[len(sorted_by2)//2]
                                Y_bot = max(Y_bot, box_by2_med * 0.98)
                                if ih is not None:
                                    Y_bot = max(0.0, min(ih-1.0, Y_bot))
                                W_est = X_right - X_left
                                H_est = W_est * math.sqrt(2)
                                Y_top = Y_bot - H_est
                                if ih is not None:
                                    Y_top = max(0.0, min(ih-1.0, Y_top))
                                q3 = {
                                    "TL": dict(x=float(X_left), y=float(Y_top), c=STAGE3_CONF, pi=-1, ki=-3),
                                    "TR": dict(x=float(X_right),y=float(Y_top), c=STAGE3_CONF, pi=-1, ki=-3),
                                    "BR": dict(x=float(X_right),y=float(Y_bot), c=STAGE3_CONF, pi=-1, ki=-3),
                                    "BL": dict(x=float(X_left), y=float(Y_bot), c=STAGE3_CONF, pi=-1, ki=-3),
                                }
                                selected = _quad_to_selected(q3); selection_stage = "3_A4_geom"
                                origin_summary["stage3_meta"] = {
                                    "X_left_raw": round(X_left_raw,1), "X_right_raw": round(X_right_raw,1),
                                    "delta_px": round(delta,1), "W_est": round(W_est,1), "H_est": round(H_est,1),
                                    "Y_top": round(Y_top,1), "Y_bot": round(Y_bot,1),
                                    "ybottom_kp_median": True if bottom_y_cands else False,
                                }
                            except Exception as e3:
                                origin_summary["stage3_err"] = str(e3)[:200]
                                # last resort: median quadrant as v4
                                def score_tl(c): return (c["x"] + c["y"], -c["c"])
                                def score_tr(c): return ((c["x"] - c["y"]) * -1.0, -c["c"])
                                def score_br(c): return (-(c["x"] + c["y"]), -c["c"])
                                def score_bl(c): return ((c["x"] - c["y"]), -c["c"])
                                if len(cands) >= 4:
                                    xs = sorted(set(cc["x"] for cc in cands)); ys = sorted(set(cc["y"] for cc in cands))
                                    if len(xs)>=2 and len(ys)>=2:
                                        mx = (xs[len(xs)//2]+xs[(len(xs)-1)//2])/2.0
                                        my = (ys[len(ys)//2]+ys[(len(ys)-1)//2])/2.0
                                        tl_pool=[cc for cc in cands if cc["x"]<=mx*1.02 and cc["y"]<=my*1.02]
                                        tr_pool=[cc for cc in cands if cc["x"]>=mx*0.98 and cc["y"]<=my*1.02]
                                        br_pool=[cc for cc in cands if cc["x"]>=mx*0.98 and cc["y"]>=my*0.98]
                                        bl_pool=[cc for cc in cands if cc["x"]<=mx*1.02 and cc["y"]>=my*0.98]
                                        pools_ok=len(tl_pool)>0 and len(tr_pool)>0 and len(br_pool)>0 and len(bl_pool)>0
                                    else: pools_ok=False; tl_pool=tr_pool=br_pool=bl_pool=cands
                                    if not pools_ok: tl_pool=tr_pool=br_pool=bl_pool=cands
                                    used_pk=set()
                                    step_order=[("TL",tl_pool,score_tl),("TR",tr_pool,score_tr),("BR",br_pool,score_br),("BL",bl_pool,score_bl)]
                                    step_order.sort(key=lambda t: -max((c["c"] for c in t[1]), default=0.0))
                                    for lbl,pool,sfn in step_order:
                                        for c in sorted(pool,key=sfn):
                                            if (c["pi"],c["ki"]) not in used_pk:
                                                selected[lbl]=dict(x=c["x"],y=c["y"],c=c["c"],pi=c["pi"],ki=c["ki"]); used_pk.add((c["pi"],c["ki"])); break
                                    selection_stage = "0_backup_v4_median"
                origin_summary["selection_stage"] = selection_stage
                # --- v6i: 双模式校准。默认ratio(跨扫图通用)，兼容老abs模式 ---
                calibrated = {}
                def _clamp(nx,ny):
                    if iw is not None: nx = max(0.0, min(float(iw)-1.0, float(nx)))
                    if ih is not None: ny = max(0.0, min(float(ih)-1.0, float(ny)))
                    return float(nx), float(ny)
                if CALIBRATION_ENABLE and all(selected.get(lbl) for lbl in ("TL","TR","BR","BL")):
                    origin_summary["selected4_before_calib"] = {
                        kk: ({"x":v["x"],"y":v["y"],"c":v["c"]} if v else None) for kk,v in selected.items()
                    }
                    if CALIBRATION_MODE == "ratio":
                        L  = float(CALIB_RATIO["LEFT_EXPAND_PCT"])
                        R  = float(CALIB_RATIO["RIGHT_EXPAND_PCT"])
                        T  = float(CALIB_RATIO["TOP_EXTRA_PCT"])
                        B  = float(CALIB_RATIO["BOT_SHRINK_PCT"])
                        A4 = float(CALIB_RATIO["A4_RATIO"])
                        TLr, TRr, BRr, BLr = selected["TL"], selected["TR"], selected["BR"], selected["BL"]
                        tlx, tly = float(TLr["x"]), float(TLr["y"])
                        trx, tryy = float(TRr["x"]), float(TRr["y"])
                        brx, bry = float(BRr["x"]), float(BRr["y"])
                        blx, bly = float(BLr["x"]), float(BLr["y"])
                        # x: 以raw左右极值为基准，按W_raw百分比扩宽
                        left_raw   = min(tlx, blx)
                        right_raw  = max(trx, brx)
                        W_raw      = max(1.0, right_raw - left_raw)
                        left_new   = left_raw  - L * W_raw
                        right_new  = right_raw + R * W_raw
                        # y: 以BR/BL y为稳定锚点（仅波动3.5%），按A4比例反推Top
                        #   真实扫图BR/BL y = 纸底y（稳定），TL/TR y偏下800px不稳定
                        bot_raw    = 0.5 * (bry + bly)  # BOT anchor
                        bot_new    = bot_raw - B * W_raw
                        paper_h    = W_raw * A4
                        top_new    = bot_new - paper_h  - T * paper_h
                        # 4角矩形化（严格平行四边形→矩形，保证透视矫正不变形）
                        TLx, TLy = _clamp(left_new,  top_new)
                        TRx, TRy = _clamp(right_new, top_new)
                        BRx, BRy = _clamp(right_new, bot_new)
                        BLx, BLy = _clamp(left_new,  bot_new)
                        calibrated["TL"] = dict(TLr, x=TLx, y=TLy, c=float(TLr.get("c",0.0)))
                        calibrated["TR"] = dict(TRr, x=TRx, y=TRy, c=float(TRr.get("c",0.0)))
                        calibrated["BR"] = dict(BRr, x=BRx, y=BRy, c=float(BRr.get("c",0.0)))
                        calibrated["BL"] = dict(BLr, x=BLx, y=BLy, c=float(BLr.get("c",0.0)))
                        origin_summary["calibration_mode_used"] = "ratio"
                        origin_summary["calib_ratio_used"] = {
                            "W_raw": round(W_raw,1), "left_raw": round(left_raw,1),
                            "right_raw": round(right_raw,1), "bot_raw": round(bot_raw,1),
                            "paper_h": round(paper_h,1),
                            "top_new": round(top_new,1), "bot_new": round(bot_new,1),
                            "left_new": round(left_new,1), "right_new": round(right_new,1),
                        }
                    else:
                        # abs模式（兼容老前端calib格式）
                        for lbl in ("TL","TR","BR","BL"):
                            v = dict(selected[lbl])
                            off = CALIBRATION_V6E.get(lbl, {"dx":0,"dy":0})
                            ox, oy = float(off.get("dx",0)), float(off.get("dy",0))
                            nx, ny = _clamp(float(v["x"]) + ox, float(v["y"]) + oy)
                            calibrated[lbl] = dict(v, x=nx, y=ny, c=float(v.get("c",0.0)))
                        origin_summary["calibration_mode_used"] = "abs"
                    origin_summary["calibration_applied"] = True
                    origin_summary["calibration_v6e"] = CALIBRATION_V6E
                    if CALIBRATION_MODE == "ratio":
                        origin_summary["calibration_ratio_params"] = dict(CALIB_RATIO)
                    selected = calibrated
                else:
                    origin_summary["calibration_applied"] = False
                topCorners = d.get("corners") if isinstance(d.get("corners"),dict) else {}
                needInject = False
                newCorners = {}
                for i, kk in enumerate(labelOrder):
                    cc = selected.get(kk)
                    existing = topCorners.get(kk) if isinstance(topCorners.get(kk),dict) else None
                    ex_cf = (existing.get("conf") or existing.get("confidence") or 0.0) if isinstance(existing,dict) else 0.0
                    ex_x = existing.get("x") if isinstance(existing,dict) else None
                    ex_y = existing.get("y") if isinstance(existing,dict) else None
                    if cc and cc["c"] > 0 and (not isinstance(existing,dict) or ex_x is None or ex_y is None or cc["c"] > ex_cf):
                        newCorners[kk] = {"x": cc["x"], "y": cc["y"], "conf": cc["c"]}
                        needInject = True
                    elif isinstance(existing,dict) and ex_x is not None:
                        newCorners[kk] = existing
                if persons and needInject and len(newCorners) >= 3:
                    d["corners"] = newCorners
                    labelOrder = ["TL", "TR", "BR", "BL"]
                    kpInjected = []
                    for kk in labelOrder:
                        c = newCorners.get(kk)
                        if isinstance(c, dict) and c.get("x") is not None:
                            kpInjected.append({"name": kk, "x": c["x"], "y": c["y"],
                                               "conf": c.get("conf", 0.0)})
                        else:
                            kpInjected.append({"name": kk, "x": 0.0, "y": 0.0, "conf": 0.0})
                    for person in persons:
                        if not isinstance(person, dict): continue
                        person["corners"] = dict(newCorners)
                        person["keypoints"] = list(kpInjected)
                        if "points" in person: person["points"] = list(kpInjected)
                        if "landmarks" in person: person["landmarks"] = list(kpInjected)
                    try:
                        data = json.dumps(d, ensure_ascii=False).encode("utf-8")
                    except Exception:
                        pass
                    origin_summary["corners_injected"] = True
                    origin_summary["inject_all_persons"] = True
                origin_summary["selected4"] = {kk: ({"x":v["x"],"y":v["y"],"c":v["c"],"pi":v["pi"],"ki":v["ki"]} if v else None) for kk,v in selected.items()}
                all_p = []
                for idx, pp in enumerate(persons):
                    box = pp.get("box") or []
                    if len(box) >= 4:
                        cx = (box[0] + box[2]) / 2
                        cy = (box[1] + box[3]) / 2
                    else:
                        cx = cy = None
                    kp4 = []
                    for k in (pp.get("keypoints") or [])[:4]:
                        if isinstance(k, dict):
                            kp4.append({"x": k.get("x"), "y": k.get("y"),
                                        "c": k.get("conf") or k.get("confidence")})
                        elif isinstance(k, list) and len(k) >= 3:
                            kp4.append({"x": k[0], "y": k[1], "c": k[2]})
                        else:
                            kp4.append(None)
                    p4 = {}
                    corners = pp.get("corners") or {}
                    for kk in ["TL","TR","BR","BL"]:
                        c = corners.get(kk)
                        if isinstance(c, dict):
                            p4[kk] = {"x": c.get("x"), "y": c.get("y"),
                                      "c": c.get("conf") or c.get("confidence")}
                    all_p.append({"i": idx, "score": pp.get("score"),
                                  "box": box[:4] if len(box) >= 4 else None,
                                  "cx": cx, "cy": cy, "kp4": kp4, "corners": p4})
                origin_summary["all_persons"] = all_p
                pp = persons[0] if persons else None
                if pp:
                    origin_summary["score"] = pp.get("score")
                    origin_summary["kp4_conf"] = [(k.get("conf") or k.get("confidence")) for k in (pp.get("keypoints") or [])[:4]]
                if isinstance(d.get("corners"),dict):
                    origin_summary["corners4_conf"] = {k: (d["corners"][k].get("conf") if isinstance(d["corners"][k],dict) else None) for k in ["TL","TR","BR","BL"] if k in d["corners"]}
                    origin_summary["corners4_xy"] = {k: {"x": d["corners"][k].get("x"), "y": d["corners"][k].get("y")} for k in ["TL","TR","BR","BL"] if k in d["corners"] and isinstance(d["corners"][k],dict)}
            except Exception as e:
                origin_summary["parse_err"] = str(e)[:300]
                import traceback
                origin_summary["parse_tb"] = traceback.format_exc(limit=2)[:500]
            rec = {"ts":ts,"path":self.path,"client":(self.client_address or ("",))[0],
                   "content_length":len(raw) if raw else 0,"file_bytes":fb_len,
                   "img":img_path,"onnx":onnx_rec,"origin":origin_summary}
            try:
                with open(JSONL,"a",encoding="utf-8") as f:
                    f.write(json.dumps(rec, ensure_ascii=False)+"\n")
            except Exception: pass
            self.send_response(status)
            for k,v in headers.items():
                if k.lower() not in ("transfer-encoding","connection","content-length"):
                    try: self.send_header(k,v)
                    except Exception: pass
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except Exception:
            try:
                self.send_response(500); self.send_header("Content-Type","text/plain"); self.end_headers()
                self.wfile.write(("ProxyErr:"+traceback.format_exc()).encode("utf-8","ignore"))
            except Exception: pass

if __name__ == "__main__":
    PORT = int(sys.argv[1]) if len(sys.argv)>1 else 8093
    print("POSE DEBUG PROXY listening 0.0.0.0:%d -> upstream %s" % (PORT, ORIGIN))
    srv = ThreadingHTTPServer(("0.0.0.0", PORT), H)
    try: srv.serve_forever()
    except KeyboardInterrupt: srv.server_close()
