# ChatShot

Capture AI chat responses as beautiful screenshots and stitch them for easy sharing.

![ChatShot Logo](icons/icon128.png)

## Features

- ? **Block Detection**: Automatically detects content blocks (paragraphs, code, tables, formulas, etc.)
- ? **Block Selection**: Choose which blocks to capture, with Select All / None controls
- ? **Block Merge / Unmerge**: Combine adjacent blocks (Shift+click + Merge) or split them back
- ?? **Horizontal Stitch (Masonry)**: Waterfall layout ¡ª blocks fill the shortest column, no wasted gaps
- ? **Vertical Stitch**: Stack blocks top to bottom in a single column
- ? **Auto Theme Detection**: Matches dark/light mode for seamless screenshots
- ? **Response Selector**: Pick any conversation response to capture, not just the latest
- ? **Smart Width Capping**: Code blocks are capped at 1200px to prevent abnormally wide screenshots
- ? **Performance Optimized**: CSS caching, depth-limited style copy, and canvas memory cleanup
- ? **Multi-Platform**: Supports 9 major AI chat platforms (see below)
- ? **Chrome & Edge**: Works on both Chromium-based browsers

### Masonry vs Row Layout

```
Row layout:                  Masonry layout:
©°©¤©¤©¤©¤©¤©¤©´ ©°©¤©¤©¤©¤©¤©¤©´          ©°©¤©¤©¤©¤©¤©¤©´ ©°©¤©¤©¤©¤©¤©¤©´
©¦  1   ©¦ ©¦      ©¦          ©¦  1   ©¦ ©¦      ©¦
©¦      ©¦ ©¦  2   ©¦          ©¦      ©¦ ©¦  2   ©¦
©¸©¤©¤©¤©¤©¤©¤©¼ ©¦      ©¦          ©¸©¤©¤©¤©¤©¤©¤©¼ ©¦      ©¦
         ©¸©¤©¤©¤©¤©¤©¤©¼          ©°©¤©¤©¤©¤©¤©¤©´ ©¸©¤©¤©¤©¤©¤©¤©¼
©¤©¤ gap ©¤©¤ ©¤©¤ gap ©¤©¤        ©¦  3   ©¦ ©°©¤©¤©¤©¤©¤©¤©´
©°©¤©¤©¤©¤©¤©¤©´                   ©¸©¤©¤©¤©¤©¤©¤©¼ ©¦  4   ©¦
©¦  3   ©¦                            ©¸©¤©¤©¤©¤©¤©¤©¼
©¸©¤©¤©¤©¤©¤©¤©¼
```

## Supported Platforms

- [x] DeepSeek (chat.deepseek.com)
- [x] NotebookLM (notebooklm.google.com)
- [x] ChatGPT (chatgpt.com)
- [x] Gemini (gemini.google.com)
- [x] Doubao (www.doubao.com)
- [x] Kimi (www.kimi.com)
- [x] Qianwen (www.qianwen.com)
- [x] ChatGLM (chatglm.cn)
- [x] Copilot (copilot.microsoft.com)
- [ ] Claude (coming soon)

## Installation

### From Source (Developer Mode)

1. Clone this repository:
   ```bash
   git clone https://github.com/70asunflower/ChatShot.git
   ```

2. Open Chrome and go to `chrome://extensions/`

3. Enable **Developer mode** (toggle in top right)

4. Click **Load unpacked** and select the `ChatShot` folder

5. Navigate to a supported AI chat platform and start capturing!

## Usage

1. Open a chat on a supported platform
2. Click **H** (horizontal) or **V** (vertical) button
3. Select/deselect content blocks you want to capture
4. *(Optional)* **Shift+click** adjacent blocks then click **Merge** to combine them
5. Click **Capture** to generate and download the image

## License

MIT License - feel free to use and modify!

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.
