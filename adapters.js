/*
 * ChatShot - LLM Platform Adapters
 * =================================
 * 独立于 content.js，通过 window.ChatShotAdapters 暴露给 content script。
 *
 * 每个适配器定义：
 *   - host             : hostname（content.js 按精确 host 匹配）
 *   - responseSelector : AI 回答容器选择器
 *   - getBlocks(el)    : 容器 DOM → 内容块数组 [{ type, elements[] }]
 *   - getResponseTitle : 回答下拉列表的标题
 *   - displayName, logo: 截图头部品牌
 *
 * 块解析采用配置驱动：getBlocks 的"切块循环"收敛为 configDrivenGetBlocks，
 * 平台差异只体现在一条 CSS 配置上（divider/section/code/table/skip）。
 * 加新站 = 新增一条配置，不再复制循环。
 */
(function () {
  'use strict';

  /**
   * 配置驱动的块解析器。
   * @param {Element} container - AI 回答容器
   * @param {Object} cfg {
   *   divider: 'selector'  分隔线：截断当前块，自身不进块
   *   section: 'selector'  新章节起始：自身作为章节首元素
   *   code:    'selector'  独立代码块
   *   table:   'selector'  独立表格块
   *   skip:    'selector'  直接跳过（如空白占位）
   * }
   * @returns {Array<{type: string, elements: HTMLElement[]}>}
   */
  function configDrivenGetBlocks(container, cfg) {
    const blocks = [];
    let currentBlock = null;

    for (const child of Array.from(container.children)) {
      if (cfg.skip && child.matches(cfg.skip)) continue;

      const isDivider = !!cfg.divider && child.matches(cfg.divider);
      const isSection = !!cfg.section && child.matches(cfg.section);
      const isCode = !!cfg.code && child.matches(cfg.code);
      const isTable = !!cfg.table && child.matches(cfg.table);

      if (isDivider) {
        if (currentBlock && currentBlock.elements.length > 0) blocks.push(currentBlock);
        currentBlock = null;
        continue;
      }

      if (isCode || isTable) {
        if (currentBlock && currentBlock.elements.length > 0) blocks.push(currentBlock);
        currentBlock = null;
        blocks.push({ type: isCode ? 'code' : 'table', elements: [child] });
        continue;
      }

      if (isSection) {
        if (currentBlock && currentBlock.elements.length > 0) blocks.push(currentBlock);
        currentBlock = { type: 'section', elements: [child] };
        continue;
      }

      if (!currentBlock) currentBlock = { type: 'default', elements: [] };
      currentBlock.elements.push(child);
    }

    if (currentBlock && currentBlock.elements.length > 0) blocks.push(currentBlock);
    return blocks;
  }

  /** 默认标题回退：取回答开头 20 字。 */
  function defaultGetResponseTitle(respElement, index) {
    const firstText = respElement.textContent?.trim().slice(0, 20);
    return firstText ? firstText + '...' : `Response ${index + 1}`;
  }

  /**
   * 通用"找前一条用户消息"：
   * 从响应元素向上找到消息容器，再在容器（或其祖先）前面的兄弟节点里
   * 查找用户消息文本。覆盖 deepseek / chatgpt / gemini 的同类逻辑。
   * @param {Element} respElement
   * @param {Object} opts {
   *   containerSelector: string  - 消息容器选择器
   *   userSelector: string|null  - 用户消息选择器；null 表示直接用兄弟节点文本
   *   startFromAncestor: number  - 0=容器自身, 1=parentElement, 2=parentElement.parentElement
   *   fallback: Element|null     - closest 失败时的兜底容器
   * }
   */
  function getUserTextFromPrecedingTurn(respElement, opts) {
    const { containerSelector, userSelector = null, startFromAncestor = 0, fallback = null } = opts;
    let container = respElement.closest(containerSelector) || fallback;
    if (!container) return null;

    for (let i = 0; i < startFromAncestor && container.parentElement; i++) {
      container = container.parentElement;
    }

    let prev = container.previousElementSibling;
    while (prev) {
      const target = userSelector ? prev.querySelector(userSelector) : prev;
      const text = target?.textContent?.trim();
      if (text) return text.slice(0, 20) + (text.length > 20 ? '...' : '');
      prev = prev.previousElementSibling;
    }
    return null;
  }

  const LLM_ADAPTERS = {
    deepseek: {
      name: 'deepseek',
      displayName: 'DeepSeek',
      logo: 'deepseek-color.png',
      host: 'chat.deepseek.com',
      responseSelector: '.ds-markdown',
      getBlocks: (container) => configDrivenGetBlocks(container, {
        divider: 'hr',
        code: '.md-code-block, pre',
        table: '.ds-scroll-area, table'
      }),
      getResponseTitle: (respElement, index) => {
        const text = getUserTextFromPrecedingTurn(respElement, {
          containerSelector: '[class*="message"]',
          fallback: respElement.parentElement
        });
        return text || defaultGetResponseTitle(respElement, index);
      }
    },
    notebooklm: {
      name: 'notebooklm',
      displayName: 'NotebookLM',
      logo: 'gemini-color.png',
      host: 'notebooklm.google.com',
      responseSelector: '.to-user-message-card-content .message-text-content',
      getBlocks: (container) => {
        const blocks = [];
        const paragraphs = container.querySelectorAll('labs-tailwind-structural-element-view-v2');
        paragraphs.forEach((p) => {
          const isHeading = p.querySelector('.paragraph.heading3');
          if (isHeading) {
            blocks.push({ type: 'section', elements: [p], isHeading: true });
          } else {
            // Group consecutive non-heading paragraphs
            const lastBlock = blocks[blocks.length - 1];
            if (lastBlock && !lastBlock.isHeading && lastBlock.type === 'paragraph') {
              lastBlock.elements.push(p);
            } else {
              blocks.push({ type: 'paragraph', elements: [p], isHeading: false });
            }
          }
        });
        return blocks;
      },
      getResponseTitle: (respElement, index) => {
        const messagePair = respElement.closest('.chat-message-pair');
        if (messagePair) {
          const userMessage = messagePair.querySelector('.from-user-container .message-text-content');
          if (userMessage) {
            const text = userMessage.textContent?.trim();
            if (text && text.length > 0) {
              return text.slice(0, 20) + (text.length > 20 ? '...' : '');
            }
          }
        }
        return defaultGetResponseTitle(respElement, index);
      }
    },
    chatgpt: {
      name: 'chatgpt',
      displayName: 'ChatGPT',
      logo: 'openai.png',
      host: 'chatgpt.com',
      responseSelector: '[data-message-author-role="assistant"] .markdown.prose',
      getBlocks: (container) => configDrivenGetBlocks(container, {
        section: 'h2, h3, ol, ul'
      }),
      getResponseTitle: (respElement, index) => {
        const text = getUserTextFromPrecedingTurn(respElement, {
          containerSelector: '[data-message-author-role="assistant"]',
          userSelector: '[data-message-author-role="user"]',
          startFromAncestor: 2
        });
        return text || defaultGetResponseTitle(respElement, index);
      }
    },
    gemini: {
      name: 'gemini',
      displayName: 'Gemini',
      logo: 'gemini-color.png',
      host: 'gemini.google.com',
      responseSelector: '.markdown.markdown-main-panel',
      getBlocks: (container) => configDrivenGetBlocks(container, {
        section: 'h2, h3',
        divider: 'hr'
      }),
      getResponseTitle: (respElement, index) => {
        const text = getUserTextFromPrecedingTurn(respElement, {
          containerSelector: 'conversation-turn, [data-turn-id]',
          userSelector: '.query-text, [data-user-query]'
        });
        return text || defaultGetResponseTitle(respElement, index);
      }
    },
    doubao: {
      name: 'doubao',
      displayName: 'Doubao',
      logo: 'doubao-color.png',
      host: 'www.doubao.com',
      responseSelector: '[data-testid="message_text_content"].flow-markdown-body',
      getBlocks: (container) => configDrivenGetBlocks(container, {
        section: 'h2, h3',
        divider: 'hr',
        skip: '.md-box-line-break'
      }),
      getResponseTitle: defaultGetResponseTitle
    },
    kimi: {
      name: 'kimi',
      displayName: 'Kimi',
      logo: 'kimi-color.png',
      host: 'www.kimi.com',
      responseSelector: '.markdown',
      getBlocks: (container) => configDrivenGetBlocks(container, {
        section: 'h2, h3, h4'
      }),
      getResponseTitle: defaultGetResponseTitle
    },
    qianwen: {
      name: 'qianwen',
      displayName: 'Qianwen',
      logo: 'qwen-color.png',
      host: 'www.qianwen.com',
      responseSelector: '.qk-markdown',
      getBlocks: (container) => configDrivenGetBlocks(container, {
        divider: 'hr, .qk-md-hr',
        section: 'h2, h3, .qk-md-head'
      }),
      getResponseTitle: defaultGetResponseTitle
    },
    chatglm: {
      name: 'chatglm',
      displayName: 'ChatGLM',
      logo: 'qingyan-color.png',
      host: 'chatglm.cn',
      responseSelector: '.answer-content-wrap',
      // 结构特殊：先收集 markdown-body 与 mermaid(code-no-artifacts) 两轮
      getBlocks: (container) => {
        const blocks = [];
        let currentBlock = null;
        const contentElements = container.querySelectorAll('.markdown-body.md-body, .code-no-artifacts');

        for (const contentEl of contentElements) {
          if (contentEl.classList.contains('code-no-artifacts')) {
            if (currentBlock && currentBlock.elements.length > 0) {
              blocks.push(currentBlock);
              currentBlock = null;
            }
            blocks.push({ type: 'code', elements: [contentEl] });
            continue;
          }

          for (const child of Array.from(contentEl.children)) {
            const tagName = child.tagName.toLowerCase();
            if (tagName === 'hr') {
              if (currentBlock && currentBlock.elements.length > 0) blocks.push(currentBlock);
              currentBlock = null;
              continue;
            }
            if (tagName === 'h3' || tagName === 'h4') {
              if (currentBlock && currentBlock.elements.length > 0) blocks.push(currentBlock);
              currentBlock = { type: 'section', elements: [child] };
            } else if (currentBlock) {
              currentBlock.elements.push(child);
            } else {
              currentBlock = { type: 'default', elements: [child] };
            }
          }
        }

        if (currentBlock && currentBlock.elements.length > 0) blocks.push(currentBlock);
        return blocks;
      },
      getResponseTitle: (respElement, index) => {
        const heading = respElement.querySelector('h3, h4');
        if (heading) return heading.textContent?.trim().slice(0, 30) || 'Response ' + (index + 1);
        return defaultGetResponseTitle(respElement, index);
      }
    },
    copilot: {
      name: 'copilot',
      displayName: 'Copilot',
      logo: 'copilot-color.png',
      host: 'copilot.microsoft.com',
      responseSelector: '.group\\/ai-message-item',
      getBlocks: (container) => configDrivenGetBlocks(container, {
        divider: 'div.pb-6, div[class*="after:border-b"]',
        section: 'h1, h2'
      }),
      getResponseTitle: (respElement, index) => {
        const heading = respElement.querySelector('h1, h2');
        if (heading) return heading.textContent?.trim().slice(0, 30) || 'Response ' + (index + 1);
        return defaultGetResponseTitle(respElement, index);
      }
    },
    qwenai: {
      name: 'qwenai',
      displayName: 'Qwen',
      logo: 'qwen-color.png',
      host: 'chat.qwen.ai',
      responseSelector: '.qwen-markdown',
      getBlocks: (container) => configDrivenGetBlocks(container, {
        skip: '.qwen-markdown-space',
        divider: 'hr, .qwen-markdown-hr',
        code: 'pre, .qwen-markdown-code',
        table: 'table, .qwen-markdown-table',
        section: 'h1, h2, h3, .qwen-markdown-heading'
      }),
      getResponseTitle: defaultGetResponseTitle
    }
  };

  window.ChatShotAdapters = { LLM_ADAPTERS };
})();
