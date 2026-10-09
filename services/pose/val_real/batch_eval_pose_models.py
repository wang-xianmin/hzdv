"""
批量对比 val_real/*.jpg 在多个 ONNX 上的 /pose 识别结果
用法：
  1) 先把手机真实 A4 图放到 val_real/a4_01.jpg ... a4_NN.jpg
  2) 在 VPS 上切 active.onnx 指到模型 A → curl /health → 跑本脚本 → 输出 a4_XX_A.json
  3) 切 active.onnx 指到模型 B → 再跑本脚本 → 输出 a4_XX_B.json
  4) 对比两个目录里同一张图的 corners 4 点欧氏距离，像素差<5px 算 pass
"""
import os, json, subprocess, hashlib, sys, glob
POSE_URL = os.environ.get("POSE_URL", "http://127.0.0.1:8093")
API_KEY = os.environ.get("POSE_API_KEY", "")
VAL_DIR = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.environ.get("OUT_DIR", os.path.join(VAL_DIR, "out_" + hashlib.md5(POSE_URL.encode()).hexdigest()[:6]))
os.makedirs(OUT_DIR, exist_ok=True)
imgs = sorted(glob.glob(os.path.join(VAL_DIR, "*.jpg")) + glob.glob(os.path.join(VAL_DIR, "*.jpeg")) + glob.glob(os.path.join(VAL_DIR, "*.png")))
if not imgs:
    print("NO_IMAGES_IN", VAL_DIR); sys.exit(0)
hdrs = []
if API_KEY:
    hdrs += ["-H", f"X-API-Key: {API_KEY}"]
for img in imgs:
    base = os.path.splitext(os.path.basename(img))[0]
    out = os.path.join(OUT_DIR, base + ".json")
    if os.path.isfile(out) and os.path.getsize(out) > 50:
        print("SKIP", os.path.basename(img), "→", out)
        continue
    r = subprocess.run(["curl", "-sS", "-X", "POST", f"{POSE_URL}/pose"] + hdrs + ["-F", f"file=@{img}"], capture_output=True)
    if r.returncode != 0:
        print("CURL_FAIL", os.path.basename(img), r.stderr.decode()[:200])
        continue
    try:
        d = json.loads(r.stdout)
    except Exception as e:
        print("JSON_FAIL", os.path.basename(img), str(e), r.stdout[:200])
        continue
    json.dump(d, open(out,"w"), ensure_ascii=False, indent=2)
    pc = d.get("person_count") or len(d.get("persons",[]) or [])
    print("OK", os.path.basename(img), "persons=", pc, "→", out)
print("ALL_DONE. out_dir=", OUT_DIR)
