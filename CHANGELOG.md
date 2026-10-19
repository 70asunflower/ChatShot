# Changelog

本文件是多个 AI 会话/人协作改这个仓库时的唯一变更台账。**约定：每次改版本号，必须在这里加一节**；提交信息用语义化前缀（feat/fix/refactor）。

## 1.5.3 — 2026-10-19

### Fixed
- **deepseek**：responseSelector 收紧为 `.ds-markdown.ds-assistant-message-main-content`。裸 `.ds-markdown` 还会命中"思考流"内容（`ds-think-content` 内），既污染回答下拉，流式生成中可能选错容器（2026-10-19 真机 DOM 确认）。
- **deepseek**：标题检测重写为**结构化攀爬**——从回答容器逐层向上找第一个"前兄弟含非噪音文本"的层级（即用户提问行）。旧实现已实际失效：哈希类 `.fbb737a4` 会随 DeepSeek 发版轮换，且 `[class*="message"]` 会匹配回答容器自身（`ds-assistant-message-main-content` 含 "message" 子串），`closest` 命中自己后永远走默认回退。
- **claude / doubao / gemini**：删除列为候选的**祖先元素**回退（`[data-testid="assistant-message"]`、裸 `[data-testid="message_text_content"]`、`message-content`）。祖先候选与 1.5.2 引入的"最外层过滤"相冲突：过滤会选中外层容器，getBlocks 只见到 1 个子元素，块解析塌缩。

### Added
- **适配器冒烟测试**（`tests/adapter-smoke.mjs`，零依赖 mini DOM shim + 10 个平台真实结构固定件）：锁定"最新回答必须解析到容器级元素、块数下限、代码/表格块检出"。专防 1.5.1 那类选择器回归。`npm test` 运行。copilot 因转义类名选择器暂未覆盖。

## 1.5.2 — 2026-10-19

### Fixed
- **deepseek/qianwen/qwenai/chatglm/chatgpt/gemini**：回退 `[class*=…]` 子串回退选择器——子串匹配会命中 `.ds-markdown-paragraph` 等叶子元素，"最新回答"解析为单个段落，永远只切出 1 个可选块（用户报障根因）。
- `findSelectedResponse` 与回答下拉只保留**最外层匹配**（通用保险：选择器写宽也不会选中叶子）。
- background 图片代取恢复 `credentials: 'include'`——1.5.1 改 `'omit'` 后，聊天里挂在登录态 CDN 的用户上传图 401/403，截图丢图。

## 1.5.1 — 2026-10-18（另一会话提交 6ee9229）

### Added
- 克隆节点消毒（去 script/iframe/object/embed、on* 句柄、javascript: URL）
- SPA 路由检测（500ms 轮询，路由变化重置选块状态）
- 截图表头/间距按像素比缩放（修高分屏表头过小）
- 选块覆盖层按滚动容器裁剪视口外显示
- package.json（`build:fonts` 脚本）

### Changed
- 各平台适配器选择器加了回退扩展（其中子串回退与祖先回退引入 1.5.2/1.5.3 修复的回归）
- background 拉图 `credentials` 改 `'omit'`（1.5.2 回退）

## 1.5.0 — 2026-10-18（bb54a00）

### Fixed
- 拼接画布超浏览器上限（16384px/面积）时整体等比缩放，不再静默产出空图
- 单块捕获失败改为跳过继续，完成后提示跳过数
- 图片直取 fetch 加 10s 超时；选块覆盖层响应窗口 resize
- `downloadImage` 改真 Promise；`showStatus` 定时器竞态

### Added
- KaTeX 20 个 woff2 字体以 data URI 内嵌（`scripts/embed-katex-fonts.mjs`，升级 KaTeX 后重跑），公式截图正确渲染字体
- `Alt+Shift+S` 全局快捷键进入选块；`Esc` 退出
- PNG/JPG 下载格式切换（剪贴板恒为 PNG）
- claude.ai 实验性适配器

### Changed
- icon128 从 1102×1004/1MB 压到 128×128/27KB；删除未引用的 katex.min.js、grok.png、notebooklm.png
- `web_accessible_resources` 从 `<all_urls>` 收窄到 11 个聊天站点
