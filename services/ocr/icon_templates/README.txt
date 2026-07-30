UI 线框图标模板（PNG，透明底 + 深色描边）。

当前映射（见 app.py 里 UI_ICON_CATALOG）：
  git_branch.png     → 🔱
  external_link.png  → ⧉

追加新图标：
  1. 裁一张干净小图放进本目录
  2. 在 UI_ICON_CATALOG 加一条 {id, char, file, threshold}
  3. 重建 OCR 镜像
