# HOW：个人资料 Passkey 面板动作区布局整理

## 背景
个人资料 → 点击 passkey 展开面板时，空态显示「暂无 Passkey」文案，且「扫码注册通行密钥」为按钮、「使用本机注册」为下划线链接并换行，视觉杂乱。

## 目标（产品已拍板）
1. **删除**空态文案「暂无 Passkey」（含英文本地化等价文案时一并清空容器，不要占位灰字）。
2. **「使用本机注册」改成与「扫码注册通行密钥」同风格的实心/描边按钮**（去掉 underline + transparent 链接样式）。
3. **两按钮同一行并排**；若一行偏长，允许整行左移（减小 panel 的 `margin-left`，或 actions 行减小左边距），保证两钮同排且不挤出模态。

## 改哪些文件
- `lib/user/profile.js`：面板 DOM/CSS；建议用一行 `.profile-passkey-actions` 包住两个注册按钮；统一按钮 class；有凭据列表时仍可显示注册入口（行为不变）。
- `lib/user/passkey-ui.js`：`renderCredentialSummary` 在 `credentials` 为空时 **不要** `renderSummaryMessage(..., "暂无 Passkey")`；改为清空容器。其它错误/加载文案保留。若登录页也依赖该空态，给 `renderSummary` 加 `opts.hideEmptyMessage`（资料页传 true）。

## 非目标
- 不改注册/扫码 API、不改 WebAuthn 流程、不改 `isSupported` 显隐逻辑。
- 不改已有凭据行的撤销 UI。

## 验收
- 打开个人资料 → 点 passkey：看不到「暂无 Passkey」。
- 「扫码注册通行密钥」「使用本机注册」均为按钮且同一行。
- 窄屏不严重溢出；本机不支持 WebAuthn 时本机按钮仍 hidden。
