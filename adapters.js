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
   * @param {HTMLElement[]} [elementsOverride] - 可选：跳过 container.children，
   * 直接用给定的扁平元素序列（见 chatgpt 的包装层扁平化）。
   * @returns {Array<{type: string, elements: HTMLElement[]}>}
   */
  function configDrivenGetBlocks(container, cfg, elementsOverride) {
    const blocks = [];
    let currentBlock = null;

    for (const child of elementsOverride || Array.from(container.children)) {
      if (cfg.skip && child.matches(cfg.skip)) continue;

      const isDivider = !!cfg.divider && (child.matches(cfg.divider) || !!child.querySelector(cfg.divider));
      const isSection = !!cfg.section && (child.matches(cfg.section) || !!child.querySelector(cfg.section));
      const isCode = !!cfg.code && (child.matches(cfg.code) || !!child.querySelector(cfg.code));
      const isTable = !!cfg.table && (child.matches(cfg.table) || !!child.querySelector(cfg.table));

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

  /** 判断是否属于思考过程或操作按钮类噪音文字 */
  function isThinkingOrMetadataText(text) {
    if (!text) return true;
    return /^(thought for|thinking|深度思考|已思考|已完成思考|已完成|思考过程|思考中|思考完成|copy|retry|edit|share)/i.test(text);
  }

  /**
   * 结构化攀爬取标题：从回答容器逐层向上，每层检查前兄弟节点的文本，
   * 第一个非"思考/操作噪音"的即用户提问。与类名无关——全哈希类站点
   * （deepseek/doubao 等）也不随发版轮换失效。
   */
  function titleFromPrecedingTurnClimb(respElement, index) {
    let cur = respElement;
    while (cur.parentElement) {
      cur = cur.parentElement;
      let prev = cur.previousElementSibling;
      while (prev) {
        const text = (prev.textContent || '').trim();
        if (text && !isThinkingOrMetadataText(text)) {
          return text.slice(0, 20) + (text.length > 20 ? '...' : '');
        }
        prev = prev.previousElementSibling;
      }
    }
    return defaultGetResponseTitle(respElement, index);
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
      if (text && !isThinkingOrMetadataText(text)) return text.slice(0, 20) + (text.length > 20 ? '...' : '');
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
      // 限定主正文容器：裸 .ds-markdown 还包括"思考流"内容（ds-think-content 内），
      // 会污染回答下拉且流式生成中可能选错容器（2026-10 真机 DOM 确认）。
      responseSelector: '.ds-markdown.ds-assistant-message-main-content',
      getBlocks: (container) => configDrivenGetBlocks(container, {
        divider: 'hr',
        code: '.md-code-block, pre',
        table: '.ds-scroll-area, table'
      }),
      getResponseTitle: titleFromPrecedingTurnClimb
    },
    notebooklm: {
      name: 'notebooklm',
      displayName: 'NotebookLM',
      logo: 'gemini-color.png',
      host: 'notebooklm.google.com',
      responseSelector: '.to-user-message-card-content .message-text-content, .message-text-content',
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
      // 2026-10 改版后：data-message-author-role / .markdown / .prose 全部移除，
      // 正文根是 CSS-Module 类 MarkdownRoot-<hash>（前缀稳定、后缀随构建轮换；
      // 用户消息发 markdown 时也会出现，需 filterResponse 排除）。
      name: 'chatgpt',
      displayName: 'ChatGPT',
      logo: 'openai.png',
      host: 'chatgpt.com',
      responseSelector: '[class*="MarkdownRoot"]',
      filterResponse: (el) => !el.closest('[class*="user-message"]'),
      // 助手正文外有单子元素匿名包装层（穿透），且段落流可能整段包在嵌套
      // DIV 里（扁平化）——两种处理都只认语义块标签，避免塌缩成 1-2 大块。
      getBlocks: (container) => {
        const BLOCKS = 'h1,h2,h3,h4,p,ul,ol,pre,table,hr';
        let inner = container;
        while (inner.children.length === 1 &&
               inner.children[0].querySelector(BLOCKS)) {
          inner = inner.children[0];
        }
        const flatten = (node) => Array.from(node.children).flatMap(k =>
          k.matches(BLOCKS) ? [k]
            : k.querySelector(BLOCKS) ? flatten(k)
              : [k]);
        return configDrivenGetBlocks(inner, {
          divider: 'hr',
          code: 'pre',
          table: 'table',
          section: 'h2, h3, h4'
        }, flatten(inner));
      },
      getResponseTitle: defaultGetResponseTitle
    },
    gemini: {
      name: 'gemini',
      displayName: 'Gemini',
      logo: 'gemini-color.png',
      host: 'gemini.google.com',
      // 不列祖先元素（message-content）：最外层过滤会选中外层容器，
      // 导致 getBlocks 只见到 1 个 markdown 子元素。
      responseSelector: '.markdown.markdown-main-panel',
      getBlocks: (container) => configDrivenGetBlocks(container, {
        divider: 'hr',
        code: 'pre, code-block',
        table: 'table',
        section: 'h2, h3, h4'
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
      // 2026-10 改版后 flow-markdown-body 及全部语义类消失（全哈希）；
      // 语义 data-testid 仍在：receive_message=助手 / send_message=用户。
      name: 'doubao',
      displayName: 'Doubao',
      logo: 'doubao-color.png',
      host: 'www.doubao.com',
      responseSelector: '[data-testid="receive_message"] [data-testid="message_text_content"]',
      getBlocks: (container) => configDrivenGetBlocks(container, {
        divider: 'hr',
        code: 'pre',
        table: 'table',
        section: 'h2, h3, h4'
      }),
      getResponseTitle: titleFromPrecedingTurnClimb
    },
    kimi: {
      name: 'kimi',
      displayName: 'Kimi',
      logo: 'kimi-color.png',
      host: 'www.kimi.com',
      responseSelector: '.markdown, [class*="chat-message-item"] .markdown',
      getBlocks: (container) => configDrivenGetBlocks(container, {
        divider: 'hr',
        code: 'pre',
        table: 'table',
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
        code: 'pre, .qk-md-code',
        table: 'table, .qk-md-table',
        section: 'h2, h3, h4, .qk-md-head'
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
      responseSelector: '.group\\/ai-message-item, [class*="ai-message-item"]',
      getBlocks: (container) => configDrivenGetBlocks(container, {
        divider: 'hr, div.pb-6, div[class*="after:border-b"]',
        code: 'pre',
        table: 'table',
        section: 'h1, h2, h3'
      }),
      getResponseTitle: (respElement, index) => {
        const heading = respElement.querySelector('h1, h2, h3');
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
        table: 'table, .qwen-markdown-table, .qwen-markdown-table-wrapper',
        section: 'h1, h2, h3, .qwen-markdown-heading'
      }),
      getResponseTitle: defaultGetResponseTitle
    },
    claude: {
      name: 'claude',
      displayName: 'Claude',
      logo: 'claude-color.png',
      host: 'claude.ai',
      // 2026-10 改版后：font-claude-message 移除。正文容器是 assistant-message
      // 下的 .standard-markdown（外层 .font-claude-response 只是样式壳，
      // 直接切块会因单包装子元素而塌缩）。
      responseSelector: '[data-testid="assistant-message"] .standard-markdown',
      getBlocks: (container) => configDrivenGetBlocks(container, {
        divider: 'hr',
        code: 'pre',
        table: 'table, .md-table-scroll',
        section: 'h1, h2, h3, h4'
      }),
      getResponseTitle: (respElement, index) => {
        const text = getUserTextFromPrecedingTurn(respElement, {
          containerSelector: '[data-test-render-count], [data-testid="conversation-turn"]',
          userSelector: '[data-testid="user-message"]'
        });
        return text || defaultGetResponseTitle(respElement, index);
      }
    }
  };

  window.ChatShotAdapters = { LLM_ADAPTERS };
})();
