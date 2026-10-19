# Privacy Policy — ChatShot

_Last updated: 2026-10-19_

ChatShot is a browser extension that captures AI chat responses as screenshots and stitches them into a single shareable image.

## Data collection

**ChatShot collects no data.** It has no analytics, no telemetry, no tracking, and communicates with no server of its own.

## What the extension does on your device

- **Block selection & rendering** — when you click *Select* / *Capture*, the extension clones the conversation content you selected, renders it to an image locally in your browser, and places the result on your clipboard and in your downloads folder.
- **Image fetching** — AI chats often embed images hosted on third-party CDNs that block direct embedding. To include those images in your screenshot, ChatShot's background worker downloads them at the moment of capture (with your existing login cookies, so images behind a login render correctly). Fetched images are converted to data URLs in memory and used only for the screenshot. They are never stored or transmitted anywhere else.
- **Store storage** — ChatShot does not use cookies, `localStorage`, `chrome.storage`, or any other persistence.

## Permissions

| Permission | Why it's needed |
|---|---|
| `activeTab` | Read the conversation on the tab you are viewing, only when you press Select/Capture. |
| `clipboardWrite` | Copy the generated screenshot image to your clipboard. |
| `host_permissions: https://*/*` | Only used to download images that appear *inside* AI chat responses (they live on arbitrary image CDNs). No other requests are made to any host. |
| `commands` | Registers the Alt+Shift+S shortcut that starts block selection. |

## Content scripts

ChatShot injects its interface only into the AI chat sites listed on its README (DeepSeek, ChatGPT, Claude, Gemini, Qwen, Kimi, Doubao, ChatGLM, Copilot, NotebookLM, Qianwen). It reads nothing from other pages.

## Contact

Open an issue at https://github.com/70asunflower/ChatShot/issues
