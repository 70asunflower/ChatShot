# Changelog

本文件是多个 AI 会话/人协作改这个仓库时的唯一变更台账。**约定：每次改版本号，必须在这里加一节**；提交信息用语义化前缀（feat/fix/refactor）。

## 1.5.5 — 2026-10-19（端到端验证补充）

### Fixed
- **notebooklm**：站点会把 `notebooklm.google.com` 重定向到 **`notebook.google.com`**（无 lm），manifest 未匹配导致内容脚本根本不注入。两个域都加入 content_scripts 与 web_accessible_resources（真机 E2E 发现）。

### Changed
- **chatgpt**：切块粒度优化（真机验证）——正文段落流整段包在嵌套 DIV 里，穿透后仍只有 1-2 个大块；configDrivenGetBlocks 新增可选 `elementsOverride` 参数，chatgpt 先把纯包装 DIV 递归扁平化为语义块序列再切块。真机效果：正文回复 2 块 → 4-9 块（章节/代码/表格独立可选）；LaTeX 源码查看器类回复保持 1 整块（其内容本就无 markdown 块元素）。

### 端到端验证（真机点 Select 数块）
deepseek 23/23 ✅ · qwen 4/4 ✅ · doubao 10/10 ✅ · claude 3/3 ✅ · qianwen 165/165 ✅ · gemini 30/30 ✅ · chatgpt 管线模拟 ✅（UI 点击因页面主线程繁忙超时，粒度修复后需 reload 复测）· notebooklm 需本版修复域名后复测

## 1.5.4 — 2026-10-19（逐站真机核对）

逐站打开真实会话页核对适配器（qwen/kimi/doubao/chatglm/qianwen/chatgpt/gemini/claude/copilot/notebooklm）。**三个站点前端已改版、旧适配器完全失效**，全部按真机 DOM 重写；每处改动补进冒烟测试固定件。

### Fixed
- **chatgpt（改版失效重写）**：`data-message-author-role`/`.markdown`/`.prose` 已全部移除。新正文根是 CSS-Module 类 `MarkdownRoot-<hash>`（前缀稳定）；用户消息发 markdown 时也含 mdRoot，新增适配器级 `filterResponse` 钩子（content.js 选块与下拉都会应用）排除 `user-message` 包装内的根；正文外有单子元素匿名包装层，getBlocks 先穿透包装层再切块，否则塌缩成 1 块。
- **doubao（改版失效重写）**：`flow-markdown-body` 与全部语义类消失（全哈希）。改用语义 testid：`[data-testid="receive_message"] [data-testid="message_text_content"]`。标题改用结构化攀爬（真机验证：正确返回用户提问，跳过"已完成思考"噪音头——噪音正则补充 已完成思考/已完成/思考完成）。
- **claude（改版失效重写）**：`.font-claude-message` 移除，正文容器改为 `[data-testid="assistant-message"] .standard-markdown`（外层 `.font-claude-response` 只是样式壳）；表格在 `.md-table-scroll` 包装内，加入 table 配置。

### Changed
- **qwenai**：table 配置显式加入 `.qwen-markdown-table-wrapper`（真机确认表格的实际直接子元素是包装层）。
- **qianwen**：（侦察确认健康，未改动；表格依赖子扫描命中 `.qk-md-table-section`）。

### 验证状态
- 真机核对通过：qwen / doubao / qianwen / chatgpt / gemini / claude / notebooklm
- 未验证（登录墙/策略拦截，配置维持现状）：kimi、chatglm（未登录）、copilot（导航被浏览器策略拒绝）

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
