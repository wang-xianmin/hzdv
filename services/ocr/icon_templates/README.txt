UI 线框图标模板（PNG，透明底 + 深色描边）。

当前映射（见 app.py 里 UI_ICON_CATALOG）：
  git_branch.png     → 🔱
  external_link.png  → ⧉
  refresh.png        → ↻（重刷；OCR 常误识为 C）
  more_horiz.png     → ⋯（横向更多）
  search.png         → 🔍（搜索）
  settings.png       → ⚙（设置）
  chevron_left.png   → <（左尖括号；threshold 0.65 防与 > 互认）
  chevron_right.png  → >（右尖括号）

追加新图标：
  1. 裁一张干净小图放进本目录
  2. 在 UI_ICON_CATALOG 加一条 {id, char, file, threshold}
  3. 重建 OCR 镜像
