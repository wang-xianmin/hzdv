"""HZDV Pose / 文档扫描微服务：YOLOv8-Pose（ONNX Runtime）+ OpenCV 透视矫正。

接口：
  GET  /health
  POST /pose          multipart: file=<image>     人体 17 关键点
  POST /pose/base64   JSON image base64
  POST /scan          multipart: file=<image>     扫描全能王式：找四角 → 亚像素吸附 → 透视 → 增强
  POST /scan/base64   JSON image base64

/scan 可传手机手点四角 corners；默认用 Shi-Tomasi 邻域吸附 + cornerSubPix 亚像素精修。

其它项目通过 POSE_SERVICE_URL + POSE_API_KEY 调用（与 OCR/ASR 同模式）。
运行时只用 onnxruntime（与 RapidOCR 一致），不依赖 torch。
"""

from __future__ import annotations

import base64
import json
import os
import time
from pathlib import Path
from typing import Any, Optional

import numpy as np
from fastapi import FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

APP_DIR = Path(__file__).resolve().parent
MODELS_DIR = Path(os.environ.get("POSE_MODELS_DIR", str(APP_DIR / "models"))).resolve()
API_KEY = (os.environ.get("POSE_API_KEY") or "").strip()
CORS_ORIGINS = (os.environ.get("POSE_CORS_ORIGINS") or "*").strip()
CONF_THRES = float(os.environ.get("POSE_CONF") or "0.25")
IOU_THRES = float(os.environ.get("POSE_IOU") or "0.7")
IMGSZ = int(os.environ.get("POSE_IMGSZ") or "640")
# 角点亚像素：手机手点偏差吸附到边缘交点
REFINE_SEARCH = int(os.environ.get("POSE_CORNER_SEARCH") or "28")  # 邻域半宽（像素）
REFINE_WIN = int(os.environ.get("POSE_CORNER_WIN") or "5")  # cornerSubPix 半窗
REFINE_MAX_MOVE = float(os.environ.get("POSE_CORNER_MAX_MOVE") or "24")  # 相对种子最大位移

COCO_KPT_NAMES = [
    "nose",
    "left_eye",
    "right_eye",
    "left_ear",
    "right_ear",
    "left_shoulder",
    "right_shoulder",
    "left_elbow",
    "right_elbow",
    "left_wrist",
    "right_wrist",
    "left_hip",
    "right_hip",
    "left_knee",
    "right_knee",
    "left_ankle",
    "right_ankle",
]

app = FastAPI(title="hzdv-pose", version="0.1.0")
_origins = ["*"] if CORS_ORIGINS == "*" else [o.strip() for o in CORS_ORIGINS.split(",") if o.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

_session = None
_meta: dict[str, Any] = {}
_input_name = "images"


def _check_api_key(x_api_key: Optional[str]) -> None:
    if not API_KEY:
        return
    if not x_api_key or x_api_key.strip() != API_KEY:
        raise HTTPException(status_code=401, detail="Invalid or missing X-API-Key")


def _load_meta() -> dict[str, Any]:
    active_json = MODELS_DIR / "active.json"
    if active_json.is_file():
        return json.loads(active_json.read_text(encoding="utf-8"))
    for name in ("yolov8n-pose", "yolov8s-pose", "yolov8m-pose"):
        onnx = MODELS_DIR / f"{name}.onnx"
        if onnx.is_file():
            return {
                "kind": "yolov8_pose",
                "name": name,
                "onnx": f"{name}.onnx",
                "imgsz": 640,
                "task": "pose",
                "keypoints": 17,
                "keypoint_names": COCO_KPT_NAMES,
            }
    raise FileNotFoundError(
        f"未找到 YOLOv8-Pose 模型。请先在 {MODELS_DIR} 运行 ./download_models.sh"
    )


def get_session():
    global _session, _meta, _input_name
    if _session is not None:
        return _session

    import onnxruntime as ort

    meta = _load_meta()
    _meta = meta
    onnx_name = str(meta.get("onnx") or "active.onnx")
    path = MODELS_DIR / onnx_name
    if not path.is_file():
        path = MODELS_DIR / "active.onnx"
    if not path.is_file():
        raise FileNotFoundError(f"模型文件不存在: {path}")

    opts = ort.SessionOptions()
    opts.intra_op_num_threads = int(os.environ.get("POSE_NUM_THREADS") or "2")
    _session = ort.InferenceSession(str(path.resolve()), sess_options=opts, providers=["CPUExecutionProvider"])
    _input_name = _session.get_inputs()[0].name
    return _session


def _read_image_bytes(data: bytes):
    import cv2

    arr = np.frombuffer(data, dtype=np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if img is None:
        raise HTTPException(status_code=400, detail="无法解码图片")
    return img


async def _upload_bytes(file: UploadFile) -> bytes:
    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="空文件")
    return data


def _decode_base64_image(raw: str) -> bytes:
    s = (raw or "").strip()
    if not s:
        raise HTTPException(status_code=400, detail="缺少 image")
    if "," in s and s.lower().startswith("data:"):
        s = s.split(",", 1)[1]
    try:
        return base64.b64decode(s, validate=False)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"无效 base64: {e}") from e


def _letterbox(img_bgr: Any, new_shape: int = 640):
    """等比缩放 + padding，返回 (blob, ratio, (pad_w, pad_h))."""
    import cv2

    h, w = img_bgr.shape[:2]
    r = min(new_shape / h, new_shape / w)
    nh, nw = int(round(h * r)), int(round(w * r))
    resized = cv2.resize(img_bgr, (nw, nh), interpolation=cv2.INTER_LINEAR)
    pad_w, pad_h = new_shape - nw, new_shape - nh
    left, top = pad_w // 2, pad_h // 2
    right, bottom = pad_w - left, pad_h - top
    padded = cv2.copyMakeBorder(resized, top, bottom, left, right, cv2.BORDER_CONSTANT, value=(114, 114, 114))
    blob = padded[:, :, ::-1].transpose(2, 0, 1).astype(np.float32) / 255.0
    blob = np.expand_dims(blob, 0)
    return blob, r, (left, top)


def _nms_xyxy(boxes: np.ndarray, scores: np.ndarray, iou_thres: float) -> list[int]:
    if len(boxes) == 0:
        return []
    x1, y1, x2, y2 = boxes[:, 0], boxes[:, 1], boxes[:, 2], boxes[:, 3]
    areas = (x2 - x1).clip(0) * (y2 - y1).clip(0)
    order = scores.argsort()[::-1]
    keep: list[int] = []
    while order.size > 0:
        i = int(order[0])
        keep.append(i)
        if order.size == 1:
            break
        xx1 = np.maximum(x1[i], x1[order[1:]])
        yy1 = np.maximum(y1[i], y1[order[1:]])
        xx2 = np.minimum(x2[i], x2[order[1:]])
        yy2 = np.minimum(y2[i], y2[order[1:]])
        inter = (xx2 - xx1).clip(0) * (yy2 - yy1).clip(0)
        iou = inter / (areas[i] + areas[order[1:]] - inter + 1e-6)
        order = order[1:][iou <= iou_thres]
    return keep


def _run_pose(img_bgr: Any) -> dict[str, Any]:
    session = get_session()
    t0 = time.perf_counter()
    blob, ratio, (pad_x, pad_y) = _letterbox(img_bgr, IMGSZ)
    outs = session.run(None, {_input_name: blob})
    pred = outs[0]
    # YOLOv8-pose: (1, 56, 8400) → (8400, 56)
    if pred.ndim == 3:
        pred = pred[0]
    if pred.shape[0] < pred.shape[1]:
        pred = pred.T

    # Auto-detect YOLOv8-pose channel layout:
    #   With cls channel (COCO 17-kpt standard)   : C = 6 + 3*nk  (4 box + 1 obj + 1 cls + 3nk kpt)
    #   Without cls channel (single-class export): C = 5 + 3*nk  (4 box + 1 obj + 3nk kpt)
    K, C = pred.shape
    nk_meta = int(_meta.get("keypoints") or 17)
    if C == 4 + 1 + 1 + 3 * nk_meta:
        boxes_xywh = pred[:, 0:4]
        scores = pred[:, 4] * pred[:, 5]
        kpts = pred[:, 6:]
    elif C == 4 + 1 + 3 * nk_meta:
        boxes_xywh = pred[:, 0:4]
        scores = pred[:, 4]
        kpts = pred[:, 5:]
    else:
        if (C - 5) > 0 and (C - 5) % 3 == 0:
            boxes_xywh = pred[:, 0:4]; scores = pred[:, 4]; kpts = pred[:, 5:]
            nk_meta = (C - 5) // 3
        elif (C - 6) > 0 and (C - 6) % 3 == 0:
            boxes_xywh = pred[:, 0:4]; scores = pred[:, 4] * pred[:, 5]; kpts = pred[:, 6:]
            nk_meta = (C - 6) // 3
        else:
            raise RuntimeError(f"Unsupported pred channel layout C={C}; expected {4+1+3*nk_meta}(no cls) or {5+1+3*nk_meta}(with cls) for nk={nk_meta}")

    mask = scores >= CONF_THRES
    boxes_xywh = boxes_xywh[mask]
    scores = scores[mask]
    kpts = kpts[mask]

    if len(scores) == 0:
        h, w = img_bgr.shape[:2]
        return {
            "success": True,
            "persons": [],
            "person_count": 0,
            "image_size": {"width": int(w), "height": int(h)},
            "model": _meta.get("name") or "yolov8-pose",
            "engine": "onnxruntime",
            "elapsed_sec": round(time.perf_counter() - t0, 4),
        }

    # cx,cy,w,h → xyxy（letterbox 坐标）
    cx, cy, bw, bh = boxes_xywh[:, 0], boxes_xywh[:, 1], boxes_xywh[:, 2], boxes_xywh[:, 3]
    xyxy = np.stack([cx - bw / 2, cy - bh / 2, cx + bw / 2, cy + bh / 2], axis=1)
    keep = _nms_xyxy(xyxy, scores, IOU_THRES)
    xyxy, scores, kpts = xyxy[keep], scores[keep], kpts[keep]

    # 还原到原图像素
    def unpad(x: float, y: float) -> tuple[float, float]:
        return (float(x) - pad_x) / ratio, (float(y) - pad_y) / ratio

    names = list(_meta.get("keypoint_names") or COCO_KPT_NAMES)
    nk = nk_meta
    persons: list[dict[str, Any]] = []
    h, w = img_bgr.shape[:2]

    for i in range(len(scores)):
        x1, y1 = unpad(xyxy[i, 0], xyxy[i, 1])
        x2, y2 = unpad(xyxy[i, 2], xyxy[i, 3])
        x1, y1 = max(0.0, min(w - 1.0, x1)), max(0.0, min(h - 1.0, y1))
        x2, y2 = max(0.0, min(w - 1.0, x2)), max(0.0, min(h - 1.0, y2))
        pts = []
        row = kpts[i]
        for j in range(nk):
            ox, oy, oc = float(row[j * 3]), float(row[j * 3 + 1]), float(row[j * 3 + 2])
            ux, uy = unpad(ox, oy)
            pts.append(
                {
                    "name": names[j] if j < len(names) else f"kpt_{j}",
                    "x": float(max(0.0, min(w - 1.0, ux))),
                    "y": float(max(0.0, min(h - 1.0, uy))),
                    "conf": oc,
                }
            )
        persons.append({"box": [x1, y1, x2, y2], "score": float(scores[i]), "keypoints": pts})

    out = {
        "success": True,
        "persons": persons,
        "person_count": len(persons),
        "image_size": {"width": int(w), "height": int(h)},
        "model": _meta.get("name") or "yolov8-pose",
        "engine": "onnxruntime",
        "elapsed_sec": round(time.perf_counter() - t0, 4),
    }
    if len(persons) == 1 and nk == 4:
        labels = ["TL", "TR", "BR", "BL"]
        corners_out = {}
        for j, pt in enumerate(persons[0]["keypoints"][:4]):
            corners_out[labels[j]] = {"x": pt["x"], "y": pt["y"], "conf": pt.get("conf", 0.0)}
        out["corners"] = corners_out
    return out


def _order_quad(pts: np.ndarray) -> np.ndarray:
    """将 4 点排序为 TL, TR, BR, BL。"""
    pts = np.asarray(pts, dtype=np.float32).reshape(4, 2)
    s = pts.sum(axis=1)
    diff = np.diff(pts, axis=1).reshape(-1)
    tl = pts[np.argmin(s)]
    br = pts[np.argmax(s)]
    tr = pts[np.argmin(diff)]
    bl = pts[np.argmax(diff)]
    return np.stack([tl, tr, br, bl], axis=0)


def _find_document_quad(img_bgr: Any) -> Optional[np.ndarray]:
    """经典轮廓法找最大四边形（扫描全能王常用思路）。"""
    import cv2

    h, w = img_bgr.shape[:2]
    scale = 800.0 / max(h, w)
    if scale < 1.0:
        small = cv2.resize(img_bgr, (int(w * scale), int(h * scale)), interpolation=cv2.INTER_AREA)
    else:
        small = img_bgr
        scale = 1.0

    gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
    gray = cv2.GaussianBlur(gray, (5, 5), 0)
    edges = cv2.Canny(gray, 50, 150)
    edges = cv2.dilate(edges, np.ones((3, 3), np.uint8), iterations=1)

    contours, _ = cv2.findContours(edges, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
    contours = sorted(contours, key=cv2.contourArea, reverse=True)[:15]
    img_area = float(small.shape[0] * small.shape[1])
    best = None
    best_area = 0.0

    for cnt in contours:
        peri = cv2.arcLength(cnt, True)
        approx = cv2.approxPolyDP(cnt, 0.02 * peri, True)
        if len(approx) != 4:
            continue
        area = float(cv2.contourArea(approx))
        if area < img_area * 0.08:
            continue
        if area > best_area:
            best_area = area
            best = approx.reshape(4, 2).astype(np.float32)

    if best is None:
        hh, ww = img_bgr.shape[:2]
        return np.array([[0, 0], [ww - 1, 0], [ww - 1, hh - 1], [0, hh - 1]], dtype=np.float32)

    return (best / scale).astype(np.float32)


def _parse_corners(raw: Any) -> Optional[np.ndarray]:
    """解析客户端四角：[[x,y]*4] 或 JSON 字符串。"""
    if raw is None or raw == "":
        return None
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except json.JSONDecodeError as e:
            raise HTTPException(status_code=400, detail=f"corners JSON 无效: {e}") from e
    try:
        arr = np.asarray(raw, dtype=np.float32).reshape(-1, 2)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"corners 格式错误: {e}") from e
    if arr.shape[0] != 4:
        raise HTTPException(status_code=400, detail="corners 须为 4 个点 [[x,y],...]")
    return arr


def _refine_corners(
    img_bgr: Any,
    seeds: np.ndarray,
    *,
    search: int = REFINE_SEARCH,
    win: int = REFINE_WIN,
    max_move: float = REFINE_MAX_MOVE,
) -> tuple[np.ndarray, list[dict[str, Any]]]:
    """将粗糙角点吸附到附近最清晰边缘交点。

    流程（每个种子点）：
      1. 局部 Shi-Tomasi（goodFeaturesToTrack）找强角点
      2. 选距种子最近且足够强的候选（无则保留种子）
      3. cv2.cornerSubPix 亚像素精修
      4. 位移超过 max_move 则回退种子，避免吸到错误边缘
    """
    import cv2

    h, w = img_bgr.shape[:2]
    gray = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2GRAY)
    # 轻微模糊压噪，利于亚像素收敛
    gray = cv2.GaussianBlur(gray, (3, 3), 0)

    search = max(8, int(search))
    win = max(2, int(win))
    criteria = (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 40, 0.001)
    win_size = (win, win)
    zero_zone = (-1, -1)

    seeds = np.asarray(seeds, dtype=np.float32).reshape(4, 2)
    out = seeds.copy()
    details: list[dict[str, Any]] = []

    for i, (sx, sy) in enumerate(seeds.tolist()):
        sx = float(np.clip(sx, 0, w - 1))
        sy = float(np.clip(sy, 0, h - 1))
        x0 = max(0, int(sx) - search)
        y0 = max(0, int(sy) - search)
        x1 = min(w, int(sx) + search + 1)
        y1 = min(h, int(sy) + search + 1)
        roi = gray[y0:y1, x0:x1]
        method = "seed"
        cand = np.array([[sx, sy]], dtype=np.float32)

        if roi.size >= 16:
            # 局部质量图：取峰值也可，优先 Shi-Tomasi 角点列表
            corners = cv2.goodFeaturesToTrack(
                roi,
                maxCorners=8,
                qualityLevel=0.01,
                minDistance=max(3.0, search * 0.15),
                blockSize=min(7, max(3, win * 2 - 1)),
                useHarrisDetector=False,
            )
            if corners is not None and len(corners) > 0:
                # 转回全图坐标，选距种子最近者
                pts = corners.reshape(-1, 2)
                pts[:, 0] += x0
                pts[:, 1] += y0
                d2 = (pts[:, 0] - sx) ** 2 + (pts[:, 1] - sy) ** 2
                j = int(np.argmin(d2))
                if float(np.sqrt(d2[j])) <= max_move:
                    cand = pts[j : j + 1].astype(np.float32)
                    method = "shi_tomasi"

        # 亚像素：以候选为初值
        refined = cand.reshape(1, 1, 2).copy()
        try:
            cv2.cornerSubPix(gray, refined, win_size, zero_zone, criteria)
            rx, ry = float(refined[0, 0, 0]), float(refined[0, 0, 1])
            method = method + "+subpix"
        except Exception:
            rx, ry = float(cand[0, 0]), float(cand[0, 1])

        rx = float(np.clip(rx, 0, w - 1))
        ry = float(np.clip(ry, 0, h - 1))
        dist = float(np.hypot(rx - sx, ry - sy))
        if dist > max_move:
            # 吸偏了：保留手点（或自动检出点）
            rx, ry = sx, sy
            method = "seed_fallback"
            dist = 0.0

        out[i, 0], out[i, 1] = rx, ry
        details.append(
            {
                "index": i,
                "seed": [sx, sy],
                "refined": [rx, ry],
                "shift_px": round(dist, 3),
                "method": method,
            }
        )

    return out, details


def _warp_document(img_bgr: Any, quad: np.ndarray) -> Any:
    import cv2

    ordered = _order_quad(quad)
    (tl, tr, br, bl) = ordered
    width_a = float(np.linalg.norm(br - bl))
    width_b = float(np.linalg.norm(tr - tl))
    height_a = float(np.linalg.norm(tr - br))
    height_b = float(np.linalg.norm(tl - bl))
    max_w = max(int(width_a), int(width_b), 1)
    max_h = max(int(height_a), int(height_b), 1)
    max_side = 2400
    scale = min(1.0, max_side / float(max(max_w, max_h)))
    max_w = max(1, int(max_w * scale))
    max_h = max(1, int(max_h * scale))
    dst = np.array([[0, 0], [max_w - 1, 0], [max_w - 1, max_h - 1], [0, max_h - 1]], dtype=np.float32)
    m = cv2.getPerspectiveTransform(ordered, dst)
    return cv2.warpPerspective(img_bgr, m, (max_w, max_h))


def _enhance_scan(img_bgr: Any, mode: str = "auto") -> Any:
    """扫描增强：auto / color / gray / binary。"""
    import cv2

    mode = (mode or "auto").lower()
    if mode == "color":
        return img_bgr
    if mode == "gray":
        return cv2.cvtColor(img_bgr, cv2.COLOR_BGR2GRAY)
    if mode == "binary":
        gray = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2GRAY)
        return cv2.adaptiveThreshold(
            gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY, 31, 10
        )
    lab = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2LAB)
    l, a, b = cv2.split(lab)
    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
    l = clahe.apply(l)
    merged = cv2.merge([l, a, b])
    out = cv2.cvtColor(merged, cv2.COLOR_LAB2BGR)
    blur = cv2.GaussianBlur(out, (0, 0), 1.0)
    return cv2.addWeighted(out, 1.35, blur, -0.35, 0)


def _encode_image(img: Any, fmt: str = "jpg", quality: int = 90) -> tuple[str, str]:
    import cv2

    fmt = (fmt or "jpg").lower()
    if fmt in ("jpg", "jpeg"):
        ok, buf = cv2.imencode(".jpg", img, [int(cv2.IMWRITE_JPEG_QUALITY), int(quality)])
        mime = "image/jpeg"
    elif fmt == "png":
        ok, buf = cv2.imencode(".png", img)
        mime = "image/png"
    else:
        raise HTTPException(status_code=400, detail="fmt 仅支持 jpg/png")
    if not ok:
        raise HTTPException(status_code=500, detail="编码失败")
    return mime, base64.b64encode(buf.tobytes()).decode("ascii")


def _run_scan(
    img_bgr: Any,
    *,
    enhance: str = "auto",
    fmt: str = "jpg",
    corners: Any = None,
    refine: bool = True,
) -> dict[str, Any]:
    t0 = time.perf_counter()
    h, w = img_bgr.shape[:2]
    user_corners = _parse_corners(corners)
    if user_corners is not None:
        # 钳到图内
        user_corners[:, 0] = np.clip(user_corners[:, 0], 0, w - 1)
        user_corners[:, 1] = np.clip(user_corners[:, 1], 0, h - 1)
        seeds = user_corners
        source = "user"
    else:
        seeds = None
        source = "auto"
        try:
            pose_res = _run_pose(img_bgr)
            persons = pose_res.get("persons") or []
            if persons:
                kpts = persons[0].get("keypoints") or []
                pts_list = []
                for kp in kpts:
                    try:
                        x = float(kp.get("x", float("nan")))
                        y = float(kp.get("y", float("nan")))
                        c = float(kp.get("conf", 0.0))
                        import math as _m
                        if _m.isfinite(x) and _m.isfinite(y) and c >= 0.25:
                            pts_list.append([x, y])
                    except Exception:
                        continue
                if len(pts_list) >= 4:
                    pts_list = pts_list[:4]
                    seeds = np.asarray(pts_list, dtype=np.float32)
                    source = "yolo"
        except Exception:
            seeds = None
        if seeds is None:
            seeds = _find_document_quad(img_bgr)
            assert seeds is not None
            source = "opencv-canny"

    seeds_ordered = _order_quad(seeds)
    refine_details: list[dict[str, Any]] = []
    if refine:
        quad, refine_details = _refine_corners(img_bgr, seeds_ordered)
        quad = _order_quad(quad)
    else:
        quad = seeds_ordered

    warped = _warp_document(img_bgr, quad)
    enhanced = _enhance_scan(warped, enhance)
    mime, b64 = _encode_image(enhanced, fmt=fmt)
    sh, sw = int(enhanced.shape[0]), int(enhanced.shape[1])
    elapsed = time.perf_counter() - t0
    corners_out = [[float(x), float(y)] for x, y in quad.tolist()]
    seeds_out = [[float(x), float(y)] for x, y in seeds_ordered.tolist()]
    return {
        "success": True,
        "corners": corners_out,
        "corners_seed": seeds_out,
        "corner_order": ["tl", "tr", "br", "bl"],
        "corner_source": source,
        "corner_refine": bool(refine),
        "corner_refine_detail": refine_details,
        "enhance": enhance,
        "image_size": {"width": int(w), "height": int(h)},
        "scan_size": {"width": int(sw), "height": int(sh)},
        "mime": mime,
        "image_base64": b64,
        "engine": (
            ("yolo-4kpt" if source == "yolo" else
             "user" if source == "user" else "opencv-canny")
            + ("+subpix" if refine else "")
        ),
        "note": (
            "手点四角经 Shi-Tomasi 邻域吸附 + cornerSubPix 亚像素精修；"
            "传 corners=[[x,y]*4] 可跳过自动找边；"
            "auto 时优先 YOLO 4-kpt 识别 A4 四角（失败兜底 OpenCV Canny 轮廓法）。"
        ),
        "elapsed_sec": round(elapsed, 4),
    }


class Base64Body(BaseModel):
    image: str = Field(..., description="纯 base64 或 data URL")
    enhance: str = Field("auto", description="scan: auto|color|gray|binary")
    fmt: str = Field("jpg", description="输出 jpg|png")
    corners: Optional[list[list[float]]] = Field(
        None, description="手机手点四角 [[x,y]*4]；缺省则自动找文档边"
    )
    refine: bool = Field(True, description="是否 Shi-Tomasi + cornerSubPix 亚像素吸附")


@app.get("/health")
def health():
    ready = False
    model_name = None
    err = None
    try:
        meta = _load_meta()
        model_name = meta.get("name")
        onnx = MODELS_DIR / str(meta.get("onnx") or "active.onnx")
        ready = onnx.is_file() or (MODELS_DIR / "active.onnx").is_file()
    except Exception as e:
        err = str(e)
    return {
        "ok": True,
        "service": "hzdv-pose",
        "ready": ready,
        "model": model_name,
        "models_dir": str(MODELS_DIR),
        "error": err,
    }


_last_pose = {"ts": None, "raw_path": None, "resp_path": None}


def _persist_pose_last(raw_jpeg_bytes, resp_dict):
    import time, json
    ts = time.strftime("%Y%m%d_%H%M%S")
    ppath = "/tmp/pose_last_resp.json"
    open(ppath, "w").write(json.dumps(resp_dict, ensure_ascii=False, indent=2))
    _last_pose.update({"ts": ts, "raw_path": None, "resp_path": ppath})


@app.get("/pose/debug")
def pose_debug(x_api_key: Optional[str] = Header(default=None, alias="X-API-Key")):
    _check_api_key(x_api_key)
    out = dict(_last_pose)
    rp = out.get("resp_path")
    if rp:
        import json as _j
        try:
            r = _j.loads(open(rp).read())
            out["person_count"] = r.get("person_count")
            out["model"] = r.get("model")
            out["engine"] = r.get("engine")
            out["success"] = r.get("success")
            out["elapsed_sec"] = r.get("elapsed_sec")
            out["corners_keys"] = sorted((r.get("corners") or {}).keys())
            if r.get("persons"):
                kps = (r["persons"][0].get("keypoints") or [])
                out["keypoints_len"] = len(kps)
                out["keypoints"] = kps
                out["corners"] = r.get("corners")
        except Exception as e:
            out["resp_read_err"] = str(e)
    return {"ok": True, "last": out}


@app.post("/pose")
async def pose_upload(
    file: UploadFile = File(...),
    x_api_key: Optional[str] = Header(default=None, alias="X-API-Key"),
):
    _check_api_key(x_api_key)
    data = await _upload_bytes(file)
    img = _read_image_bytes(data)
    try:
        resp = _run_pose(img)
    except FileNotFoundError as e:
        raise HTTPException(status_code=503, detail=str(e)) from e
    try:
        _persist_pose_last(data, resp)
    except Exception:
        pass
    return resp


@app.post("/pose/base64")
async def pose_base64(
    body: Base64Body,
    x_api_key: Optional[str] = Header(default=None, alias="X-API-Key"),
):
    _check_api_key(x_api_key)
    jpg_bytes = _decode_base64_image(body.image)
    img = _read_image_bytes(jpg_bytes)
    try:
        resp = _run_pose(img)
    except FileNotFoundError as e:
        raise HTTPException(status_code=503, detail=str(e)) from e
    try:
        _persist_pose_last(jpg_bytes, resp)
    except Exception:
        pass
    return resp


def _form_bool(raw: Any, default: bool = True) -> bool:
    if raw is None or raw == "":
        return default
    s = str(raw).strip().lower()
    if s in ("0", "false", "no", "off"):
        return False
    if s in ("1", "true", "yes", "on"):
        return True
    return default


@app.post("/scan")
async def scan_upload(
    file: UploadFile = File(...),
    enhance: str = Form("auto"),
    fmt: str = Form("jpg"),
    corners: Optional[str] = Form(None),
    refine: Optional[str] = Form("true"),
    x_api_key: Optional[str] = Header(default=None, alias="X-API-Key"),
):
    _check_api_key(x_api_key)
    data = await _upload_bytes(file)
    img = _read_image_bytes(data)
    return _run_scan(
        img,
        enhance=enhance,
        fmt=fmt,
        corners=corners,
        refine=_form_bool(refine, True),
    )


@app.post("/scan/base64")
async def scan_base64(
    body: Base64Body,
    x_api_key: Optional[str] = Header(default=None, alias="X-API-Key"),
):
    _check_api_key(x_api_key)
    img = _read_image_bytes(_decode_base64_image(body.image))
    return _run_scan(
        img,
        enhance=body.enhance,
        fmt=body.fmt,
        corners=body.corners,
        refine=bool(body.refine),
    )
