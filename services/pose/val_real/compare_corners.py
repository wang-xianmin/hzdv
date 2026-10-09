"""用法: python3 compare_corners.py out_dirA out_dirB → 像素差 pass/fail 表"""
import os, json, sys, glob, math
A,B = sys.argv[1], sys.argv[2]
files = sorted([os.path.basename(x) for x in glob.glob(os.path.join(A,"*.json"))])
print(f"{image:20s}  {d_TL:>6s} {d_TR:>6s} {d_BR:>6s} {d_BL:>6s} {max:>6s}  pass")
def extract4(j):
    # FE normalizePoseResponse 两种格式优先：
    # 1) corners={"TL":{x,y,conf}} 直接读
    # 2) persons[0].keypoints[0..3] 当 TL TR BR BL
    if isinstance(j.get("corners"), dict):
        order = ["TL","TR","BR","BL"]
        if all(k in j["corners"] for k in order):
            return [[j["corners"][k]["x"],j["corners"][k]["y"]] for k in order]
    ps = j.get("persons") or []
    if ps and isinstance(ps[0].get("keypoints"), list) and len(ps[0]["keypoints"])>=4:
        kpts = ps[0]["keypoints"]
        return [[kpts[i]["x"],kpts[i]["y"]] for i in range(4)]
    return None
def dist(p,q): return math.hypot(p[0]-q[0], p[1]-q[1])
ok,tot=0,0
for f in files:
    ja = json.load(open(os.path.join(A,f)))
    jb = json.load(open(os.path.join(B,f)))
    pa,pb = extract4(ja), extract4(jb)
    if not pa or not pb:
        print(f"{f:20s}   --- missing corners ---"); tot+=1; continue
    ds=[dist(pa[i],pb[i]) for i in range(4)]
    mx=max(ds); tot+=1
    if mx<5.0: ok+=1
    print(f"{f:20s}  {ds[0]:6.1f} {ds[1]:6.1f} {ds[2]:6.1f} {ds[3]:6.1f} {mx:6.1f}   {PASS if mx<5.0 else FAIL}")
print(f"TOTAL {ok}/{tot} PASS = {ok*100.0/max(1,tot):.1f}%")
