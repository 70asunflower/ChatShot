/*
 * ChatShot - Browser extension to screenshot & stitch LLM chat responses.
 *
 * ARCHITECTURE OVERVIEW
 * ====================
 * This content script runs on supported LLM chat pages (DeepSeek, ChatGPT, etc.).
 *
 * DATA FLOW:
 *   1. Platform Detection  - getCurrentPlatform() matches hostname to an adapter
 *   2. Response Selection   - User picks which AI response to capture via dropdown
 *   3. Block Detection      - adapter.getBlocks() parses the response DOM into blocks
 *                             Each block = { type: string, elements: HTMLElement[] }
 *   4. Selection Mode       - Green overlays shown on blocks; user can toggle/merge/unmerge
 *   5. Capture              - Each selected block is cloned into an off-screen container,
 *                             styles are copied, then html2canvas renders it to a <canvas>
 *   6. Stitching            - Block canvases are arranged into a final image:
 *                             Horizontal mode = masonry/waterfall multi-column layout
 *                             Vertical mode   = single column, stacked top-to-bottom
 *   7. Download             - Final canvas exported as PNG via data URL
 *
 * LLM ADAPTER SYSTEM:
 *   Each adapter in LLM_ADAPTERS defines:
 *     - host             : hostname to match for this platform
 *     - responseSelector  : CSS selector for the AI response container
 *     - getBlocks(el)     : splits the container DOM into content blocks
 *     - getResponseTitle  : derives a short title from the response for the dropdown
 *     - displayName, logo : branding for the screenshot header
 *
 * KNOWN ISSUES / GOTCHAS:
 *   - Table blocks (.ds-scroll-area on DeepSeek) report wider getBoundingClientRect()
 *     than their visible area due to scrollable overflow. This causes overlay misalignment
 *     and garbled capture when width:100% is forced on the clone. The table's native
 *     column layout is lost because copyElementStyles() only copies a limited set of CSS
 *     properties (see COPY_STYLE_PROPS) and omits table-layout / column-width properties.
 *   - getBlocksMaxWidth() currently uses the widest element's client rect + 32px padding,
 *     clamped to [400, 1200]. This can be too narrow for short text or too wide for tables.
 *     Attempts to use container-based width detection (.ds-message / .ds-markdown) have
 *     caused regressions; see git log for details.
 */
(function() {
  'use strict';

  // Layout constants for the final stitched image
  const CONFIG = {
    maxRowWidth: 3000,  // max total pixel width of the masonry output
    blockGap: 4,        // gap between blocks in masonry layout (px)
    rowGap: 20,         // (unused legacy) gap between rows
    backgroundColor: '#1a1a1a',
    padding: 20         // outer padding of the final image (px)
  };

  // ====================================================================
  // SECTION: LLM Platform Adapters
  // Each adapter handles one AI chat platform's DOM structure.
  // Key contract: getBlocks(container) -> Array<{ type, elements[] }>
  // ====================================================================
  const LLM_ADAPTERS = {
    deepseek: {
      name: 'deepseek',
      displayName: 'DeepSeek',
      logo: 'deepseek-color.png',
      host: 'chat.deepseek.com',
      responseSelector: '.ds-markdown',
      getBlocks: (container) => {
        const blocks = [];
        let currentBlock = null;
        const children = Array.from(container.children);

        for (const child of children) {
          const tagName = child.tagName.toLowerCase();
          const isCode = child.classList.contains('md-code-block') || tagName === 'pre';
          const isTable = child.classList.contains('ds-scroll-area') || tagName === 'table';
          const isDivider = tagName === 'hr';

          if (isDivider) {
            if (currentBlock && currentBlock.elements.length > 0) {
              blocks.push(currentBlock);
              currentBlock = null;
            }
            continue;
          }

          if (isCode || isTable) {
            if (currentBlock && currentBlock.elements.length > 0) {
              blocks.push(currentBlock);
              currentBlock = null;
            }
            blocks.push({
              type: isCode ? 'code' : 'table',
              elements: [child]
            });
            continue;
          }

          if (!currentBlock) currentBlock = { type: 'section', elements: [] };
          currentBlock.elements.push(child);
        }

        if (currentBlock && currentBlock.elements.length > 0) {
          blocks.push(currentBlock);
        }
        return blocks;
      },
      getResponseTitle: (respElement, index) => {
        let parent = respElement.closest('[class*="message"]') || respElement.parentElement;
        let prevSibling = parent?.previousElementSibling;
        if (prevSibling) {
          const userText = prevSibling.textContent?.trim();
          if (userText && userText.length > 0) {
            return userText.slice(0, 20) + (userText.length > 20 ? '...' : '');
          }
        }
        const firstText = respElement.textContent?.trim().slice(0, 20);
        return firstText ? firstText + '...' : `Response ${index + 1}`;
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
        paragraphs.forEach((p, i) => {
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
        const firstText = respElement.textContent?.trim().slice(0, 20);
        return firstText ? firstText + '...' : `Response ${index + 1}`;
      }
    },
    chatgpt: {
      name: 'chatgpt',
      displayName: 'ChatGPT',
      logo: 'openai.png',
      host: 'chatgpt.com',
      responseSelector: '[data-message-author-role="assistant"] .markdown.prose',
      getBlocks: (container) => {
        const blocks = [];
        let currentBlock = null;
        const children = Array.from(container.children);
        for (const child of children) {
          const tagName = child.tagName.toLowerCase();
          // Treat h2, h3, ol, ul as section starters
          if (tagName === 'h2' || tagName === 'h3' || tagName === 'ol' || tagName === 'ul') {
            if (currentBlock && currentBlock.elements.length > 0) {
              blocks.push(currentBlock);
            }
            currentBlock = { type: 'section', elements: [child] };
          } else if (currentBlock) {
            currentBlock.elements.push(child);
          } else {
            currentBlock = { type: 'default', elements: [child] };
          }
        }
        if (currentBlock && currentBlock.elements.length > 0) {
          blocks.push(currentBlock);
        }
        return blocks;
      },
      getResponseTitle: (respElement, index) => {
        // Find the parent message container and look for the user message
        const messageContainer = respElement.closest('[data-message-author-role="assistant"]');
        if (messageContainer) {
          // Look for previous sibling with user role
          let prevEl = messageContainer.parentElement?.parentElement?.previousElementSibling;
          while (prevEl) {
            const userMsg = prevEl.querySelector('[data-message-author-role="user"]');
            if (userMsg) {
              const text = userMsg.textContent?.trim();
              if (text && text.length > 0) {
                return text.slice(0, 20) + (text.length > 20 ? '...' : '');
              }
            }
            prevEl = prevEl.previousElementSibling;
          }
        }
        const firstText = respElement.textContent?.trim().slice(0, 20);
        return firstText ? firstText + '...' : `Response ${index + 1}`;
      }
    },
    gemini: {
      name: 'gemini',
      displayName: 'Gemini',
      logo: 'gemini-color.png',
      host: 'gemini.google.com',
      responseSelector: '.markdown.markdown-main-panel',
      getBlocks: (container) => {
        const blocks = [];
        let currentBlock = null;
        const children = Array.from(container.children);
        for (const child of children) {
          const tagName = child.tagName.toLowerCase();
          // h2, h3, hr as section dividers
          if (tagName === 'h2' || tagName === 'h3' || tagName === 'hr') {
            if (currentBlock && currentBlock.elements.length > 0) {
              blocks.push(currentBlock);
            }
            if (tagName === 'hr') {
              currentBlock = null; // hr is just a divider, don't include it
            } else {
              currentBlock = { type: 'section', elements: [child] };
            }
          } else if (currentBlock) {
            currentBlock.elements.push(child);
          } else {
            currentBlock = { type: 'default', elements: [child] };
          }
        }
        if (currentBlock && currentBlock.elements.length > 0) {
          blocks.push(currentBlock);
        }
        return blocks;
      },
      getResponseTitle: (respElement, index) => {
        // Look for the user query in the conversation
        const conversationTurn = respElement.closest('conversation-turn, [data-turn-id]');
        if (conversationTurn) {
          const prevTurn = conversationTurn.previousElementSibling;
          if (prevTurn) {
            const userQuery = prevTurn.querySelector('.query-text, [data-user-query]');
            if (userQuery) {
              const text = userQuery.textContent?.trim();
              if (text && text.length > 0) {
                return text.slice(0, 20) + (text.length > 20 ? '...' : '');
              }
            }
          }
        }
        const firstText = respElement.textContent?.trim().slice(0, 20);
        return firstText ? firstText + '...' : `Response ${index + 1}`;
      }
    },
    doubao: {
      name: 'doubao',
      displayName: 'Doubao',
      logo: 'doubao-color.png',
      host: 'www.doubao.com',
      responseSelector: '[data-testid="message_text_content"].flow-markdown-body',
      getBlocks: (container) => {
        const blocks = [];
        let currentBlock = null;
        const children = Array.from(container.children);
        for (const child of children) {
          const tagName = child.tagName.toLowerCase();
          // Skip line break divs
          if (child.classList.contains('md-box-line-break')) continue;
          
          // h2, h3, hr as section dividers
          if (tagName === 'h2' || tagName === 'h3' || tagName === 'hr') {
            if (currentBlock && currentBlock.elements.length > 0) {
              blocks.push(currentBlock);
            }
            if (tagName === 'hr') {
              currentBlock = null;
            } else {
              currentBlock = { type: 'section', elements: [child] };
            }
          } else if (currentBlock) {
            currentBlock.elements.push(child);
          } else {
            currentBlock = { type: 'default', elements: [child] };
          }
        }
        if (currentBlock && currentBlock.elements.length > 0) {
          blocks.push(currentBlock);
        }
        return blocks;
      },
      getResponseTitle: (respElement, index) => {
        const firstText = respElement.textContent?.trim().slice(0, 20);
        return firstText ? firstText + '...' : `Response ${index + 1}`;
      }
    },
    kimi: {
      name: 'kimi',
      displayName: 'Kimi',
      logo: 'kimi-color.png',
      host: 'www.kimi.com',
      responseSelector: '.markdown',
      getBlocks: (container) => {
        const blocks = [];
        let currentBlock = null;
        const children = Array.from(container.children);
        for (const child of children) {
          const tagName = child.tagName.toLowerCase();
          
          // h2, h3, h4 as section dividers
          if (tagName === 'h2' || tagName === 'h3' || tagName === 'h4') {
            if (currentBlock && currentBlock.elements.length > 0) {
              blocks.push(currentBlock);
            }
            currentBlock = { type: 'section', elements: [child] };
          } else if (currentBlock) {
            currentBlock.elements.push(child);
          } else {
            currentBlock = { type: 'default', elements: [child] };
          }
        }
        if (currentBlock && currentBlock.elements.length > 0) {
          blocks.push(currentBlock);
        }
        return blocks;
      },
      getResponseTitle: (respElement, index) => {
        const firstText = respElement.textContent?.trim().slice(0, 20);
        return firstText ? firstText + '...' : `Response ${index + 1}`;
      }
    },
    qianwen: {
      name: 'qianwen',
      displayName: 'Qianwen',
      logo: 'qwen-color.png',
      host: 'www.qianwen.com',
      responseSelector: '.qk-markdown',
      getBlocks: (container) => {
        const blocks = [];
        let currentBlock = null;
        const children = Array.from(container.children);
        for (const child of children) {
          const tagName = child.tagName.toLowerCase();
          
          // hr as section divider, h2/h3 as section headers
          if (tagName === 'hr' || child.classList.contains('qk-md-hr')) {
            if (currentBlock && currentBlock.elements.length > 0) {
              blocks.push(currentBlock);
            }
            currentBlock = null;
            continue;
          }
          
          if (tagName === 'h2' || tagName === 'h3' || child.classList.contains('qk-md-head')) {
            if (currentBlock && currentBlock.elements.length > 0) {
              blocks.push(currentBlock);
            }
            currentBlock = { type: 'section', elements: [child] };
          } else if (currentBlock) {
            currentBlock.elements.push(child);
          } else {
            currentBlock = { type: 'default', elements: [child] };
          }
        }
        if (currentBlock && currentBlock.elements.length > 0) {
          blocks.push(currentBlock);
        }
        return blocks;
      },
      getResponseTitle: (respElement, index) => {
        const firstText = respElement.textContent?.trim().slice(0, 20);
        return firstText ? firstText + '...' : `Response ${index + 1}`;
      }
    },
    chatglm: {
      name: 'chatglm',
      displayName: 'ChatGLM',
      logo: 'qingyan-color.png',
      host: 'chatglm.cn',
      responseSelector: '.answer-content-wrap',
      getBlocks: (container) => {
        const blocks = [];
        let currentBlock = null;
        
        // Collect all content elements: markdown-body divs and code-no-artifacts (mermaid)
        const contentElements = container.querySelectorAll('.markdown-body.md-body, .code-no-artifacts');
        
        for (const contentEl of contentElements) {
          // For code blocks (mermaid), treat as a single block
          if (contentEl.classList.contains('code-no-artifacts')) {
            if (currentBlock && currentBlock.elements.length > 0) {
              blocks.push(currentBlock);
              currentBlock = null;
            }
            blocks.push({ type: 'code', elements: [contentEl] });
            continue;
          }
          
          // For markdown content, parse children
          const children = Array.from(contentEl.children);
          for (const child of children) {
            const tagName = child.tagName.toLowerCase();
            
            // hr as section divider
            if (tagName === 'hr') {
              if (currentBlock && currentBlock.elements.length > 0) {
                blocks.push(currentBlock);
              }
              currentBlock = null;
              continue;
            }
            
            // h3/h4 as section headers
            if (tagName === 'h3' || tagName === 'h4') {
              if (currentBlock && currentBlock.elements.length > 0) {
                blocks.push(currentBlock);
              }
              currentBlock = { type: 'section', elements: [child] };
            } else if (currentBlock) {
              currentBlock.elements.push(child);
            } else {
              currentBlock = { type: 'default', elements: [child] };
            }
          }
        }
        
        if (currentBlock && currentBlock.elements.length > 0) {
          blocks.push(currentBlock);
        }
        return blocks;
      },
      getResponseTitle: (respElement, index) => {
        const heading = respElement.querySelector('h3, h4');
        if (heading) return heading.textContent?.trim().slice(0, 30) || `Response ${index + 1}`;
        const firstText = respElement.textContent?.trim().slice(0, 20);
        return firstText ? firstText + '...' : `Response ${index + 1}`;
      }
    },
    copilot: {
      name: 'copilot',
      displayName: 'Copilot',
      logo: 'copilot-color.png',
      host: 'copilot.microsoft.com',
      responseSelector: '.group\\/ai-message-item',
      getBlocks: (container) => {
        const blocks = [];
        let currentBlock = null;
        const children = Array.from(container.children);
        for (const child of children) {
          const tagName = child.tagName.toLowerCase();
          
          // Divider: div with border-b (section separator)
          const isDivider = tagName === 'div' && (
            child.classList.contains('pb-6') ||
            child.className.includes('after:border-b')
          );
          if (isDivider) {
            if (currentBlock && currentBlock.elements.length > 0) {
              blocks.push(currentBlock);
            }
            currentBlock = null;
            continue;
          }
          
          // h1/h2 as section headers
          if (tagName === 'h1' || tagName === 'h2') {
            if (currentBlock && currentBlock.elements.length > 0) {
              blocks.push(currentBlock);
            }
            currentBlock = { type: 'section', elements: [child] };
          } else if (currentBlock) {
            currentBlock.elements.push(child);
          } else {
            currentBlock = { type: 'default', elements: [child] };
          }
        }
        if (currentBlock && currentBlock.elements.length > 0) {
          blocks.push(currentBlock);
        }
        return blocks;
      },
      getResponseTitle: (respElement, index) => {
        const heading = respElement.querySelector('h1, h2');
        if (heading) return heading.textContent?.trim().slice(0, 30) || `Response ${index + 1}`;
        const firstText = respElement.textContent?.trim().slice(0, 20);
        return firstText ? firstText + '...' : `Response ${index + 1}`;
      }
    }
  };

  // ====================================================================
  // SECTION: Platform Detection & Global State
  // ====================================================================

  // Match current hostname to an adapter; fallback to deepseek
  function getCurrentPlatform() {
    const host = window.location.host;
    for (const [key, adapter] of Object.entries(LLM_ADAPTERS)) {
      if (host.includes(adapter.host)) {
        return adapter;
      }
    }
    return LLM_ADAPTERS.deepseek;
  }

  let currentAdapter = null;

  // --- Global state ---
  let selectedResponseIndex = -1;  // -1 = latest response
  let detectedBgColor = null;      // cached background color for current capture session
  let isCancelled = false;         // capture cancellation flag

  // --- Selection mode state ---
  let isSelectionMode = false;
  let currentCaptureMode = 'horizontal'; // 'horizontal' | 'vertical'
  let detectedBlocks = [];               // Array<{ type, elements[] }>
  let selectedBlockIndices = new Set();  // indices of blocks to capture
  let mergeSelectedIndices = new Set(); // For merge multi-select

  // ====================================================================
  // SECTION: UI Initialization
  // Creates the floating button panel, response selector dropdown,
  // and selection-mode toolbar. Called once on page load.
  // ====================================================================
  function init() {
    if (document.querySelector('.ds-screenshot-btn')) return;
    currentAdapter = getCurrentPlatform();

    const container = document.createElement('div');
    container.className = 'ds-screenshot-btn';
    container.innerHTML = `
      <div class="ds-response-selector">
        <button id="ds-selector-btn" title="Select response">Latest</button>
        <div id="ds-response-list" class="ds-response-list"></div>
      </div>
      <div class="ds-screenshot-buttons">
        <button id="ds-capture-h" title="Horizontal stitch">H</button>
        <button id="ds-capture-v" title="Vertical stitch">V</button>
      </div>
      <div class="ds-screenshot-status" id="ds-status"></div>
    `;
    document.body.appendChild(container);

    // Selection mode toolbar
    const toolbar = document.createElement('div');
    toolbar.id = 'ds-selection-toolbar';
    toolbar.className = 'ds-selection-toolbar';
    toolbar.innerHTML = `
      <span id="ds-selection-count">Selected: 0/0</span>
      <button id="ds-select-all">All</button>
      <button id="ds-select-none">None</button>
      <button id="ds-merge-blocks" title="Shift+click blocks to select, then merge">Merge</button>
      <button id="ds-unmerge-block" title="Unmerge selected merged block">Unmerge</button>
      <button id="ds-confirm-capture">Capture</button>
      <button id="ds-cancel-selection">Cancel</button>
    `;
    document.body.appendChild(toolbar);

    // Bind events
    document.getElementById('ds-capture-h').addEventListener('click', () => enterSelectionMode('horizontal'));
    document.getElementById('ds-capture-v').addEventListener('click', () => enterSelectionMode('vertical'));
    document.getElementById('ds-selector-btn').addEventListener('click', toggleResponseList);
    document.getElementById('ds-confirm-capture').addEventListener('click', confirmCapture);
    document.getElementById('ds-cancel-selection').addEventListener('click', exitSelectionMode);
    document.getElementById('ds-select-all').addEventListener('click', selectAllBlocks);
    document.getElementById('ds-select-none').addEventListener('click', selectNoBlocks);
    document.getElementById('ds-merge-blocks').addEventListener('click', mergeSelectedBlocks);
    document.getElementById('ds-unmerge-block').addEventListener('click', unmergeSelectedBlock);

    document.addEventListener('click', (e) => {
      if (!e.target.closest('.ds-response-selector')) {
        document.getElementById('ds-response-list')?.classList.remove('show');
      }
    });

    console.log('[ChatShot] Plugin loaded');
  }

  // Toggle response list
  function toggleResponseList(e) {
    e.stopPropagation();
    const listEl = document.getElementById('ds-response-list');
    
    if (listEl.classList.contains('show')) {
      listEl.classList.remove('show');
      return;
    }

    const responses = document.querySelectorAll(currentAdapter.responseSelector);
    listEl.innerHTML = '';

    const latestItem = document.createElement('div');
    latestItem.className = 'ds-response-item' + (selectedResponseIndex === -1 ? ' selected' : '');
    latestItem.textContent = 'Latest response';
    latestItem.addEventListener('click', () => selectResponse(-1, 'Latest'));
    listEl.appendChild(latestItem);

    responses.forEach((resp, index) => {
      const item = document.createElement('div');
      item.className = 'ds-response-item' + (selectedResponseIndex === index ? ' selected' : '');
      let title = getResponseTitle(resp, index);
      item.textContent = `${index + 1}. ${title}`;
      item.addEventListener('click', () => selectResponse(index, title));
      listEl.appendChild(item);
    });

    listEl.classList.add('show');
  }

  function getResponseTitle(respElement, index) {
    return currentAdapter.getResponseTitle(respElement, index);
  }

  function selectResponse(index, title) {
    selectedResponseIndex = index;
    const btnText = index === -1 ? 'Latest' : `${title.slice(0, 12)}${title.length > 12 ? '...' : ''}`;
    document.getElementById('ds-selector-btn').textContent = btnText;
    document.getElementById('ds-response-list').classList.remove('show');
  }

  function showStatus(message, type = 'info') {
    const statusEl = document.getElementById('ds-status');
    statusEl.textContent = message;
    statusEl.className = 'ds-screenshot-status show ' + type;
    if (type !== 'info') {
      setTimeout(() => { statusEl.className = 'ds-screenshot-status'; }, 3000);
    }
  }

  // ====================================================================
  // SECTION: Selection Mode
  // User selects/deselects content blocks via green overlays.
  // Supports: toggle, select-all, select-none, merge, unmerge.
  // ====================================================================
  function enterSelectionMode(mode) {
    if (isSelectionMode) return;

    const response = findSelectedResponse();
    if (!response) {
      showStatus('No AI response found', 'error');
      return;
    }

    currentCaptureMode = mode;
    detectedBlocks = detectBlocks(response);
    
    if (detectedBlocks.length === 0) {
      showStatus('No content blocks detected', 'error');
      return;
    }

    isSelectionMode = true;
    selectedBlockIndices = new Set(detectedBlocks.map((_, i) => i));

    document.getElementById('ds-selection-toolbar').classList.add('show');
    document.querySelector('.ds-screenshot-btn').style.display = 'none';

    // Create overlays
    detectedBlocks.forEach((block, index) => {
      addBlockOverlay(block, index);
    });

    updateSelectionCount();
    updateOverlayPositions();
    
    // Add scroll listener (capture phase to catch all scroll events)
    window.addEventListener('scroll', updateOverlayPositions, true);
    
    if (detectedBlocks[0]?.elements[0]) {
      detectedBlocks[0].elements[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  // Exit selection mode
  function exitSelectionMode() {
    isSelectionMode = false;
    detectedBlocks = [];
    selectedBlockIndices.clear();

    window.removeEventListener('scroll', updateOverlayPositions, true);
    document.getElementById('ds-selection-toolbar').classList.remove('show');
    document.querySelector('.ds-screenshot-btn').style.display = '';
    document.querySelectorAll('.ds-block-overlay').forEach(el => el.remove());
  }

  // Add overlay element
  function addBlockOverlay(block, index) {
    const overlay = document.createElement('div');
    overlay.className = 'ds-block-overlay selected';
    overlay.dataset.index = index;

    const checkbox = document.createElement('div');
    checkbox.className = 'ds-block-checkbox';
    checkbox.innerHTML = '&#10003;';
    overlay.appendChild(checkbox);

    const number = document.createElement('div');
    number.className = 'ds-block-number';
    number.textContent = index + 1;
    overlay.appendChild(number);

    overlay.addEventListener('click', (e) => toggleBlockSelection(index, e));
    document.body.appendChild(overlay);
  }

  // Update overlay positions on scroll
  function updateOverlayPositions() {
    detectedBlocks.forEach((block, index) => {
      const overlay = document.querySelector(`.ds-block-overlay[data-index="${index}"]`);
      if (!overlay) return;

      const firstEl = block.elements[0];
      const lastEl = block.elements[block.elements.length - 1];
      const firstRect = firstEl.getBoundingClientRect();
      const lastRect = lastEl.getBoundingClientRect();
      
      overlay.style.position = 'fixed';
      overlay.style.left = (firstRect.left - 8) + 'px';
      overlay.style.top = (firstRect.top - 4) + 'px';
      overlay.style.width = (Math.max(firstRect.width, lastRect.width) + 16) + 'px';
      overlay.style.height = (lastRect.bottom - firstRect.top + 8) + 'px';
    });
  }

  // Toggle block selection (with Shift support for merge)
  function toggleBlockSelection(index, event) {
    const overlay = document.querySelector(`.ds-block-overlay[data-index="${index}"]`);
    const isShiftClick = event?.shiftKey;
    
    if (isShiftClick) {
      // Shift+click: toggle merge selection (visual highlight)
      if (mergeSelectedIndices.has(index)) {
        mergeSelectedIndices.delete(index);
        overlay?.classList.remove('merge-selected');
      } else {
        mergeSelectedIndices.add(index);
        overlay?.classList.add('merge-selected');
      }
      updateMergeCount();
      updateUnmergeState();
    } else {
      // Normal click: toggle capture selection
      if (selectedBlockIndices.has(index)) {
        selectedBlockIndices.delete(index);
        overlay?.classList.remove('selected');
      } else {
        selectedBlockIndices.add(index);
        overlay?.classList.add('selected');
      }
      updateSelectionCount();
    }
  }

  function updateMergeCount() {
    const btn = document.getElementById('ds-merge-blocks');
    if (mergeSelectedIndices.size >= 2) {
      btn.textContent = `Merge (${mergeSelectedIndices.size})`;
      btn.classList.add('active');
    } else {
      btn.textContent = 'Merge';
      btn.classList.remove('active');
    }
  }

  // Merge selected blocks into one
  function mergeSelectedBlocks() {
    if (mergeSelectedIndices.size < 2) {
      showStatus('Shift+click 2+ adjacent blocks to merge', 'error');
      return;
    }
    
    const indices = Array.from(mergeSelectedIndices).sort((a, b) => a - b);
    
    // Check if indices are consecutive
    for (let i = 1; i < indices.length; i++) {
      if (indices[i] !== indices[i-1] + 1) {
        showStatus('Can only merge adjacent blocks', 'error');
        return;
      }
    }
    
    // Merge blocks
    const firstIdx = indices[0];
    const mergedElements = [];
    indices.forEach(idx => {
      mergedElements.push(...detectedBlocks[idx].elements);
    });
    
    // Create merged block with original blocks stored for unmerge
    const originalBlocks = indices.map(idx => detectedBlocks[idx]);
    const mergedBlock = { type: 'merged', elements: mergedElements, originalBlocks: originalBlocks };
    
    // Replace in detectedBlocks array
    detectedBlocks.splice(firstIdx, indices.length, mergedBlock);
    
    // Update selectedBlockIndices to account for removed blocks
    const newSelected = new Set();
    selectedBlockIndices.forEach(idx => {
      if (idx < firstIdx) {
        newSelected.add(idx);
      } else if (idx >= firstIdx + indices.length) {
        newSelected.add(idx - indices.length + 1);
      } else {
        // Was one of merged blocks, select the new merged block
        newSelected.add(firstIdx);
      }
    });
    selectedBlockIndices = newSelected;
    mergeSelectedIndices.clear();
    
    // Rebuild overlays
    document.querySelectorAll('.ds-block-overlay').forEach(el => el.remove());
    detectedBlocks.forEach((block, i) => {
      addBlockOverlay(block, i);
      if (selectedBlockIndices.has(i)) {
        document.querySelector(`.ds-block-overlay[data-index="${i}"]`)?.classList.add('selected');
      }
    });
    updateOverlayPositions();
    updateSelectionCount();
    updateMergeCount();
    
    showStatus(`Merged ${indices.length} blocks`, 'success');
  }

  // Unmerge a selected merged block
  function unmergeSelectedBlock() {
    // Find a merged block in mergeSelectedIndices
    const mergeIdx = Array.from(mergeSelectedIndices).find(idx => 
      detectedBlocks[idx] && detectedBlocks[idx].type === 'merged' && detectedBlocks[idx].originalBlocks
    );
    
    if (mergeIdx === undefined) {
      showStatus('Shift+click a merged block to unmerge', 'error');
      return;
    }
    
    const mergedBlock = detectedBlocks[mergeIdx];
    const originalBlocks = mergedBlock.originalBlocks;
    const numOriginal = originalBlocks.length;
    
    // Replace merged block with original blocks
    detectedBlocks.splice(mergeIdx, 1, ...originalBlocks);
    
    // Update selectedBlockIndices to account for added blocks
    const newSelected = new Set();
    selectedBlockIndices.forEach(idx => {
      if (idx < mergeIdx) {
        newSelected.add(idx);
      } else if (idx === mergeIdx) {
        // Select all restored blocks
        for (let i = 0; i < numOriginal; i++) {
          newSelected.add(mergeIdx + i);
        }
      } else {
        newSelected.add(idx + numOriginal - 1);
      }
    });
    selectedBlockIndices = newSelected;
    mergeSelectedIndices.clear();
    
    // Rebuild overlays
    document.querySelectorAll('.ds-block-overlay').forEach(el => el.remove());
    detectedBlocks.forEach((block, i) => {
      addBlockOverlay(block, i);
      if (selectedBlockIndices.has(i)) {
        document.querySelector(`.ds-block-overlay[data-index="${i}"]`)?.classList.add('selected');
      }
    });
    updateOverlayPositions();
    updateSelectionCount();
    updateMergeCount();
    updateUnmergeState();
    
    showStatus(`Unmerged into ${numOriginal} blocks`, 'success');
  }

  // Update unmerge button state
  function updateUnmergeState() {
    const btn = document.getElementById('ds-unmerge-block');
    if (!btn) return;
    
    // Check if any merge-selected block is a merged block
    const hasMergedBlock = Array.from(mergeSelectedIndices).some(idx => 
      detectedBlocks[idx] && detectedBlocks[idx].type === 'merged' && detectedBlocks[idx].originalBlocks
    );
    
    if (hasMergedBlock) {
      btn.classList.add('active');
    } else {
      btn.classList.remove('active');
    }
  }

  function selectAllBlocks() {
    detectedBlocks.forEach((_, i) => {
      selectedBlockIndices.add(i);
      document.querySelector(`.ds-block-overlay[data-index="${i}"]`)?.classList.add('selected');
    });
    updateSelectionCount();
  }

  function selectNoBlocks() {
    selectedBlockIndices.clear();
    document.querySelectorAll('.ds-block-overlay').forEach(el => el.classList.remove('selected'));
    updateSelectionCount();
  }

  function updateSelectionCount() {
    document.getElementById('ds-selection-count').textContent = 
      `Selected: ${selectedBlockIndices.size}/${detectedBlocks.length}`;
  }

  // ====================================================================
  // SECTION: Capture Pipeline
  // Flow: confirmCapture -> doCapture -> captureBlock (per block) -> stitch -> download
  // ====================================================================

  async function confirmCapture() {
    if (selectedBlockIndices.size === 0) {
      showStatus('Please select at least one block', 'error');
      return;
    }
    const blocksToCapture = Array.from(selectedBlockIndices)
      .sort((a, b) => a - b)
      .map(i => detectedBlocks[i]);
    exitSelectionMode();
    await doCapture(blocksToCapture, currentCaptureMode);
  }

  // Main capture orchestrator: captures blocks one by one, then stitches
  async function doCapture(blocks, mode) {
    const btnH = document.getElementById('ds-capture-h');
    const btnV = document.getElementById('ds-capture-v');
    btnH.disabled = true;
    btnV.disabled = true;

    detectedBgColor = null;
    isCancelled = false;
    cachedCssText = null; // Reset CSS cache for fresh capture

    // Show cancel button during capture
    const statusEl = document.getElementById('ds-status');
    const cancelBtn = document.createElement('button');
    cancelBtn.id = 'ds-capture-cancel';
    cancelBtn.className = 'ds-cancel-btn';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.style.marginTop = '6px';
    cancelBtn.onclick = () => {
      isCancelled = true;
      cancelBtn.textContent = 'Cancelling...';
      cancelBtn.disabled = true;
      cancelBtn.style.opacity = '0.6';
      showStatus('Cancelling...', 'info');
    };
    statusEl.parentElement.appendChild(cancelBtn);

    try {
      showStatus('Preparing...', 'info');
      
      // Defer heavy computation to allow UI to update first
      await new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));

      showStatus(`Calculating layout...`, 'info');
      // Calculate max width of all blocks for uniform output
      const maxWidth = getBlocksMaxWidth(blocks);
      
      await new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));

      const canvases = [];
      for (let i = 0; i < blocks.length; i++) {
        if (isCancelled) {
          showStatus('Cancelled', 'error');
          return;
        }
        showStatus(`Capturing (${i + 1}/${blocks.length})...`, 'info');
        
        // Allow UI to update between captures
        await new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));
        
        const canvas = await captureBlock(blocks[i], maxWidth);
        canvases.push(canvas);
      }

      if (isCancelled) {
        showStatus('Cancelled', 'error');
        return;
      }

      showStatus('Stitching images...', 'info');
      await new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));
      
      // Load platform logo for header
      const logoImg = await loadLogo();
      
      const finalCanvas = mode === 'horizontal' 
        ? stitchImagesHorizontal(canvases, logoImg)
        : stitchImagesVertical(canvases, logoImg);

      // Free individual block canvases to reduce memory
      for (const c of canvases) {
        c.width = 0;
        c.height = 0;
      }
      canvases.length = 0;

      downloadImage(finalCanvas);
      
      // Free final canvas after download
      finalCanvas.width = 0;
      finalCanvas.height = 0;
      
      // Clear CSS cache to free memory
      cachedCssText = null;
      
      showStatus('Done!', 'success');

    } catch (error) {
      console.error('[ChatShot] Error:', error);
      showStatus('Error: ' + error.message, 'error');
    } finally {
      btnH.disabled = false;
      btnV.disabled = false;
      // Remove cancel button
      const cancelEl = document.getElementById('ds-capture-cancel');
      if (cancelEl) cancelEl.remove();
    }
  }

  function findSelectedResponse() {
    const responses = document.querySelectorAll(currentAdapter.responseSelector);
    if (responses.length === 0) return null;
    if (selectedResponseIndex === -1) return responses[responses.length - 1];
    if (selectedResponseIndex >= 0 && selectedResponseIndex < responses.length) {
      return responses[selectedResponseIndex];
    }
    return responses[responses.length - 1];
  }

  function detectBlocks(container) {
    return currentAdapter.getBlocks(container);
  }

  // Detect dark/light theme from page CSS to match screenshot background
  function detectThemeBackground() {
    const html = document.documentElement;
    const body = document.body;
    
    // Check explicit dark mode classes/attributes
    const hasDarkClass = 
      html.classList.contains('dark') || body.classList.contains('dark') ||
      html.classList.contains('dark-mode') || body.classList.contains('dark-mode') ||
      html.getAttribute('data-theme') === 'dark' || body.getAttribute('data-theme') === 'dark' ||
      html.getAttribute('data-color-mode') === 'dark';
    
    if (hasDarkClass) return '#1e1e1e';
    
    // Check computed background color of body
    const bodyBg = window.getComputedStyle(body).backgroundColor;
    if (isColorDark(bodyBg)) return '#1e1e1e';
    
    // Check main content area background
    const mainContent = document.querySelector('main') || document.querySelector('[role="main"]');
    if (mainContent) {
      const mainBg = window.getComputedStyle(mainContent).backgroundColor;
      if (mainBg && mainBg !== 'transparent' && mainBg !== 'rgba(0, 0, 0, 0)') {
        return isColorDark(mainBg) ? '#1e1e1e' : '#ffffff';
      }
    }
    
    return '#ffffff'; // Default to light
  }

  function isColorDark(color) {
    if (!color || color === 'transparent' || color === 'rgba(0, 0, 0, 0)') return false;
    const match = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    if (!match) return false;
    const luminance = 0.299 * parseInt(match[1])/255 + 0.587 * parseInt(match[2])/255 + 0.114 * parseInt(match[3])/255;
    return luminance < 0.5;
  }

  // Calculate a uniform capture width for all blocks.
  // Prefer the actual response container width so code blocks, tables, and text
  // all render at the same width they use on the page.
  function getBlocksMaxWidth(blocks) {
    let maxContextWidth = 0;
    let maxElementWidth = 0;

    for (const block of blocks) {
      const contextEl = block?.elements?.[0]?.closest(currentAdapter.responseSelector);
      if (contextEl) {
        maxContextWidth = Math.max(maxContextWidth, contextEl.getBoundingClientRect().width);
      }

      for (const el of block.elements) {
        const rect = el.getBoundingClientRect();
        maxElementWidth = Math.max(maxElementWidth, rect.width);
      }
    }

    const preferredWidth = maxContextWidth || maxElementWidth;
    const MAX_CAPTURE_WIDTH = 1200;
    return Math.min(Math.max(preferredWidth, 400), MAX_CAPTURE_WIDTH);
  }

  // Cache CSS rules to avoid re-collecting for every block
  let cachedCssText = null;

  function isTableLikeElement(el) {
    if (!el) return false;
    const tagName = el.tagName?.toLowerCase();
    return tagName === 'table' || tagName === 'thead' || tagName === 'tbody' ||
      tagName === 'tr' || tagName === 'th' || tagName === 'td' ||
      el.classList?.contains('ds-scroll-area');
  }

  function isTableBlock(block) {
    return block.type === 'table' || block.elements.some(el =>
      isTableLikeElement(el) || el.querySelector?.('table, .ds-scroll-area')
    );
  }

  function getBlockRenderContext(block) {
    const firstEl = block?.elements?.[0];
    if (!firstEl) return null;
    return firstEl.closest(currentAdapter.responseSelector);
  }

  function copyCssVariablesFromAncestors(source, target) {
    const chain = [];
    let node = source;
    while (node && node.nodeType === Node.ELEMENT_NODE) {
      chain.unshift(node);
      node = node.parentElement;
    }

    for (const el of chain) {
      const style = window.getComputedStyle(el);
      for (let i = 0; i < style.length; i++) {
        const prop = style[i];
        if (prop.startsWith('--')) {
          target.style.setProperty(prop, style.getPropertyValue(prop));
        }
      }
    }
  }

  function createCaptureContentRoot(block, tempContainer) {
    const sourceRoot = getBlockRenderContext(block);
    if (!sourceRoot) return tempContainer;

    const contentRoot = document.createElement('div');
    contentRoot.className = sourceRoot.className;
    contentRoot.style.width = '100%';
    contentRoot.style.maxWidth = '100%';
    contentRoot.style.boxSizing = 'border-box';
    copyCssVariablesFromAncestors(sourceRoot, contentRoot);
    tempContainer.appendChild(contentRoot);
    return contentRoot;
  }

  function preserveTableLayoutStyles(source, target) {
    const style = window.getComputedStyle(source);
    const extraProps = [
      'width', 'min-width', 'max-width', 'height',
      'table-layout', 'border-collapse', 'border-spacing',
      'vertical-align', 'word-break', 'overflow', 'overflow-x', 'overflow-y'
    ];
    for (const prop of extraProps) {
      target.style[prop] = style.getPropertyValue(prop);
    }
  }

  function normalizeTableCloneLayout(root) {
    root.querySelectorAll('.ds-scroll-area__gutters').forEach((el) => el.remove());

    root.querySelectorAll('.ds-scroll-area').forEach((el) => {
      el.style.width = '100%';
      el.style.minWidth = '100%';
      el.style.maxWidth = '100%';
      el.style.boxSizing = 'border-box';
      el.style.overflowX = 'visible';
      el.style.overflowY = 'visible';
    });

    root.querySelectorAll('table').forEach((table) => {
      table.style.width = '100%';
      table.style.minWidth = '100%';
      table.style.maxWidth = '100%';
      table.style.tableLayout = 'auto';
      table.style.borderCollapse = table.style.borderCollapse || 'collapse';
    });

    root.querySelectorAll('th, td').forEach((cell) => {
      cell.style.whiteSpace = 'normal';
      cell.style.wordBreak = 'keep-all';
    });
  }

  // Capture a single block to a <canvas>.
  // Process: clone elements -> copy inline styles -> inject page CSS -> html2canvas
  async function captureBlock(block, targetWidth = 800) {
    if (!detectedBgColor) detectedBgColor = detectThemeBackground();
    const bgColor = detectedBgColor;
    const tableBlock = isTableBlock(block);

    const tempContainer = document.createElement('div');
    tempContainer.style.cssText =
      'position: absolute; left: -9999px; top: 0;' +
      'background: ' + bgColor + '; padding: 16px;' +
      'width: ' + targetWidth + 'px; min-width: ' + targetWidth + 'px;' +
      'max-width: ' + targetWidth + 'px;' +
      'text-align: left; overflow: ' + (tableBlock ? 'visible' : 'hidden') + ';';

    const contentRoot = createCaptureContentRoot(block, tempContainer);

    for (const el of block.elements) {
      const clone = el.cloneNode(true);
      copyElementStyles(el, clone, 0);
      if (tableBlock && isTableLikeElement(el)) {
        preserveTableLayoutStyles(el, clone);
      } else {
        clone.style.width = '100%';
      }
      clone.style.boxSizing = 'border-box';
      contentRoot.appendChild(clone);
    }

    contentRoot.querySelectorAll('pre, .md-code-block, .ds-scroll-area').forEach(pre => {
      pre.style.width = '100%';
      pre.style.maxWidth = '100%';
      pre.style.overflow = 'hidden';
      pre.style.boxSizing = 'border-box';
    });

    if (tableBlock) {
      normalizeTableCloneLayout(contentRoot);
    }

    document.body.appendChild(tempContainer);
    copyComputedStyles(tempContainer);

    try {
      const canvas = await html2canvas(tempContainer, {
        backgroundColor: bgColor,
        scale: 2,
        useCORS: true,
        allowTaint: true,
        foreignObjectRendering: false,
        removeContainer: true,
        logging: false
      });
      return canvas;
    } finally {
      tempContainer.remove();
    }
  }

  // ====================================================================
  // SECTION: Style Copying
  // Cloned elements lose their page styles. We copy a subset of computed
  // styles recursively, plus inject all page CSS rules into the container.
  // IMPORTANT: This list does NOT include 'width', 'height', 'table-layout',
  //   'border-collapse', etc. Adding 'width' fixes tables but may break
  //   text blocks that should reflow to targetWidth.
  // ====================================================================
  const COPY_STYLE_PROPS = ['color', 'font-family', 'font-size', 'font-weight', 'line-height',
     'background-color', 'border', 'padding', 'margin', 'text-align',
     'display', 'list-style-type', 'white-space'];
  const MAX_STYLE_DEPTH = 8; // max recursion depth for child elements

  function copyElementStyles(source, target, depth) {
    if (depth > MAX_STYLE_DEPTH) return;
    const style = window.getComputedStyle(source);
    for (const prop of COPY_STYLE_PROPS) {
      target.style[prop] = style.getPropertyValue(prop);
    }
    if (isTableLikeElement(source)) {
      preserveTableLayoutStyles(source, target);
    }
    const len = Math.min(source.children.length, target.children.length);
    for (let i = 0; i < len; i++) {
      copyElementStyles(source.children[i], target.children[i], depth + 1);
    }
  }

  function copyComputedStyles(container) {
    // Cache CSS text so we only collect rules once per capture session
    if (cachedCssText === null) {
      const parts = [];
      try {
        for (const sheet of document.styleSheets) {
          try {
            const rules = sheet.cssRules;
            for (let i = 0; i < rules.length; i++) {
              parts.push(rules[i].cssText);
            }
          } catch (e) {}
        }
      } catch (e) {}
      cachedCssText = parts.join('\n');
    }
    const style = document.createElement('style');
    style.textContent = cachedCssText;
    container.insertBefore(style, container.firstChild);
  }

  // ====================================================================
  // SECTION: Image Stitching & Output
  // After capturing each block to a canvas, blocks are composed into
  // a final image with a branded header (logo + platform name).
  // ====================================================================

  async function loadLogo() {
    if (!currentAdapter?.logo) return null;
    try {
      const url = chrome.runtime.getURL('logos/' + currentAdapter.logo);
      return await new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => resolve(null);
        img.src = url;
      });
    } catch (e) {
      return null;
    }
  }

  const HEADER_HEIGHT = 72;  // px, height of the branded header bar
  const LOGO_SIZE = 48;      // px, logo dimensions in the header

  function drawHeader(ctx, totalWidth, logoImg, bgColor) {
    const isDark = bgColor === '#1e1e1e';
    
    // Header background
    ctx.fillStyle = isDark ? '#2a2a2a' : '#f5f5f5';
    ctx.fillRect(0, 0, totalWidth, HEADER_HEIGHT);
    
    // Subtle bottom border
    ctx.fillStyle = isDark ? '#3a3a3a' : '#e0e0e0';
    ctx.fillRect(0, HEADER_HEIGHT - 1, totalWidth, 1);
    
    let textX = CONFIG.padding + 8;
    
    // Draw logo
    if (logoImg) {
      const logoY = (HEADER_HEIGHT - LOGO_SIZE) / 2;
      ctx.drawImage(logoImg, CONFIG.padding + 8, logoY, LOGO_SIZE, LOGO_SIZE);
      textX = CONFIG.padding + 8 + LOGO_SIZE + 12;
    }
    
    // Draw platform name
    const displayName = currentAdapter?.displayName || currentAdapter?.name || 'ChatShot';
    ctx.fillStyle = isDark ? '#ffffff' : '#333333';
    ctx.font = 'bold 20px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.fillText(displayName, textX, HEADER_HEIGHT / 2);
  }

  // Masonry layout: blocks placed into N columns, each block goes into the shortest column.
  // All columns use the same width (= widest block canvas) to avoid jagged right edges.
  function stitchImagesHorizontal(canvases, logoImg) {
    if (canvases.length === 0) return null;
    
    // Determine number of columns based on maximum block width
    const blockWidth = Math.max(...canvases.map(c => c.width));
    const numCols = Math.max(2, Math.min(canvases.length, 
      Math.floor((CONFIG.maxRowWidth - CONFIG.padding * 2 + CONFIG.blockGap) / (blockWidth + CONFIG.blockGap))
    ));
    
    const headerOffset = HEADER_HEIGHT;
    
    // Masonry layout: place each block in the shortest column
    const colHeights = new Array(numCols).fill(CONFIG.padding + headerOffset);
    const placements = []; // { canvas, x, y }
    
    for (const canvas of canvases) {
      // Find the shortest column
      let minCol = 0;
      for (let c = 1; c < numCols; c++) {
        if (colHeights[c] < colHeights[minCol]) minCol = c;
      }
      
      const x = CONFIG.padding + minCol * (blockWidth + CONFIG.blockGap);
      const y = colHeights[minCol];
      placements.push({ canvas, x, y });
      colHeights[minCol] = y + canvas.height + CONFIG.blockGap;
    }
    
    // Calculate final dimensions
    const totalWidth = CONFIG.padding * 2 + numCols * blockWidth + (numCols - 1) * CONFIG.blockGap;
    const totalHeight = Math.max(...colHeights) - CONFIG.blockGap + CONFIG.padding;
    
    const finalCanvas = document.createElement('canvas');
    finalCanvas.width = totalWidth;
    finalCanvas.height = totalHeight;
    const ctx = finalCanvas.getContext('2d');
    const bgColor = detectedBgColor || '#ffffff';
    ctx.fillStyle = bgColor;
    ctx.fillRect(0, 0, totalWidth, totalHeight);
    
    // Draw header
    drawHeader(ctx, totalWidth, logoImg, bgColor);
    
    for (const { canvas, x, y } of placements) {
      // Force drawing at exactly blockWidth to eliminate jagged edges
      ctx.drawImage(canvas, 0, 0, canvas.width, canvas.height, x, y, blockWidth, canvas.height);
    }
    return finalCanvas;
  }

  // Simple vertical stack: all blocks in a single column, top to bottom.
  function stitchImagesVertical(canvases, logoImg) {
    if (canvases.length === 0) return null;
    const gap = 2;
    const headerOffset = HEADER_HEIGHT;
    let maxWidth = 0, totalHeight = CONFIG.padding * 2 + headerOffset;
    for (const canvas of canvases) {
      maxWidth = Math.max(maxWidth, canvas.width);
      totalHeight += canvas.height + gap;
    }
    totalHeight -= gap;
    maxWidth += CONFIG.padding * 2;

    const finalCanvas = document.createElement('canvas');
    finalCanvas.width = maxWidth;
    finalCanvas.height = totalHeight;
    const ctx = finalCanvas.getContext('2d');
    const bgColor = detectedBgColor || '#ffffff';
    ctx.fillStyle = bgColor;
    ctx.fillRect(0, 0, maxWidth, totalHeight);

    // Draw header
    drawHeader(ctx, maxWidth, logoImg, bgColor);

    let y = CONFIG.padding + headerOffset;
    for (const canvas of canvases) {
      ctx.drawImage(canvas, CONFIG.padding, y);
      y += canvas.height + gap;
    }
    return finalCanvas;
  }

  function downloadImage(canvas) {
    const now = new Date();
    const ts = now.getFullYear() + String(now.getMonth()+1).padStart(2,'0') +
      String(now.getDate()).padStart(2,'0') + '_' + String(now.getHours()).padStart(2,'0') +
      String(now.getMinutes()).padStart(2,'0') + String(now.getSeconds()).padStart(2,'0');
    const platformName = currentAdapter?.name || 'chatshot';
    const filename = `${platformName}_${ts}.png`;
    try {
      const a = document.createElement('a');
      a.href = canvas.toDataURL('image/png');
      a.download = filename;
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    } catch (e) {
      console.error('[ChatShot] Download failed:', e);
      showStatus('Error: Failed to download', 'error');
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();



