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
 *                             styles are inlined, then html-to-image renders via SVG foreignObject
 *   6. Stitching            - Block images are arranged into a final stitched image:
 *                             Column count (1-4) chosen by user; 1 = single column,
 *                             2+ = masonry/waterfall multi-column layout
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
 *     than their visible area due to scrollable overflow.
 *   - getBlocksMaxWidth() clamps capture width to [400, 1200].
 */
(function() {
  'use strict';

  const DEBUG = false; // Set to true to enable performance logging

  // Layout constants for the final stitched image
  const CONFIG = {
    padding: 20         // outer padding of the final image (px)
  };

  // ====================================================================
  // SECTION: Platform Adapters
  // LLM_ADAPTERS 定义在 adapters.js（window.ChatShotAdapters），
  // 这里只解构引用——content.js 不再直接维护平台 DOM 细节。
  // ====================================================================
  const { LLM_ADAPTERS } = window.ChatShotAdapters;

  // ====================================================================
  // SECTION: Platform Detection & Global State
  // ====================================================================

  // Match current hostname to an adapter; fallback to deepseek.
  // Exact host match (or subdomain) — substring matching could false-positive
  // when two platform hosts share a prefix, and it depends on object order.
  function getCurrentPlatform() {
    const host = window.location.host;
    for (const [key, adapter] of Object.entries(LLM_ADAPTERS)) {
      if (host === adapter.host || host.endsWith('.' + adapter.host)) {
        return adapter;
      }
    }
    return LLM_ADAPTERS.deepseek;
  }

  let currentAdapter = null;

  // --- Global state ---
  let selectedResponseEl = null;    // null = latest response (stored as DOM ref to survive lazy re-render)
  let detectedBgColor = null;       // cached background color for current capture session
  let isCancelled = false;         // capture cancellation flag
  let cachedOncloneCssText = null; // CSS cache per capture session

  // --- Selection mode state ---
  let isSelectionMode = false;
  const MIN_COLUMNS = 1;
  const MAX_COLUMNS = 4;
  let currentColumns = 2;
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
      <button id="ds-start-capture" class="ds-start-btn" title="Select blocks to capture">Select</button>
      <div class="ds-screenshot-status" id="ds-status"></div>
    `;
    document.body.appendChild(container);

    // Selection mode toolbar
    const toolbar = document.createElement('div');
    toolbar.id = 'ds-selection-toolbar';
    toolbar.className = 'ds-selection-toolbar';
    toolbar.innerHTML = `
      <div class="ds-selection-count">
        <span class="ds-selection-count-label">Selected</span>
        <span class="ds-selection-count-value" id="ds-selection-count">0/0</span>
      </div>
      <button id="ds-select-all" class="ds-btn-ghost">All</button>
      <button id="ds-select-none" class="ds-btn-ghost">None</button>
      <div class="ds-toolbar-separator"></div>
      <button id="ds-merge-blocks" title="Ctrl+click blocks to select, then merge">Merge</button>
      <button id="ds-unmerge-block" title="Unmerge selected merged block">Unmerge</button>
      <div class="ds-toolbar-separator"></div>
      <div class="ds-column-stepper">
        <button id="ds-col-dec" class="ds-stepper-btn" title="Fewer columns">−</button>
        <span id="ds-col-value" class="ds-stepper-value">2</span>
        <button id="ds-col-inc" class="ds-stepper-btn" title="More columns">+</button>
      </div>
      <div class="ds-toolbar-separator"></div>
      <button id="ds-confirm-capture">Capture</button>
      <button id="ds-cancel-selection">Cancel</button>
    `;
    document.body.appendChild(toolbar);

    // Bind events
    function updateStepperState() {
      document.getElementById('ds-col-value').textContent = currentColumns;
      document.getElementById('ds-col-dec').disabled = currentColumns <= MIN_COLUMNS;
      document.getElementById('ds-col-inc').disabled = currentColumns >= MAX_COLUMNS;
    }
    document.getElementById('ds-col-dec').addEventListener('click', () => {
      if (currentColumns > MIN_COLUMNS) {
        currentColumns--;
        updateStepperState();
      }
    });
    document.getElementById('ds-col-inc').addEventListener('click', () => {
      if (currentColumns < MAX_COLUMNS) {
        currentColumns++;
        updateStepperState();
      }
    });
    document.getElementById('ds-start-capture').addEventListener('click', () => enterSelectionMode());
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

    updateStepperState(); // sync stepper UI with initial currentColumns state

    DEBUG && console.log('[ChatShot] Plugin loaded');
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
    latestItem.className = 'ds-response-item' + (selectedResponseEl === null ? ' selected' : '');
    latestItem.textContent = 'Latest response';
    latestItem.addEventListener('click', () => selectResponse(null, 'Latest'));
    listEl.appendChild(latestItem);

    responses.forEach((resp, index) => {
      const item = document.createElement('div');
      item.className = 'ds-response-item' + (selectedResponseEl === resp ? ' selected' : '');
      const title = currentAdapter.getResponseTitle(resp, index);
      // Reverse numbering: newest = 1, oldest = N
      const num = responses.length - index;
      item.textContent = `${num}. ${title}`;
      item.addEventListener('click', () => selectResponse(resp, title));
      listEl.appendChild(item);
    });

    listEl.classList.add('show');
  }

  function selectResponse(el, title) {
    selectedResponseEl = el;
    const btnText = el === null ? 'Latest' : `${title.slice(0, 12)}${title.length > 12 ? '...' : ''}`;
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

  function showSelectionToast(message, durationMs = 1500) {
    // Reuse a single toast element so rapid triggers don't stack overlapping toasts.
    const prev = document.getElementById('ds-selection-toast');
    if (prev) prev.remove();

    const toast = document.createElement('div');
    toast.id = 'ds-selection-toast';
    toast.textContent = message;
    toast.style.cssText = [
      'position: fixed',
      'left: 50%',
      'top: 50%',
      'transform: translate(-50%, -50%)',
      'padding: 10px 14px',
      'border-radius: 8px',
      'background: rgba(239, 68, 68, 0.92)',
      'color: #fff',
      'font-size: 15px',
      'text-align: center',
      'box-shadow: 0 8px 24px rgba(0,0,0,0.45)',
      'z-index: 10002',
      'pointer-events: none',
      'opacity: 1',
      'transition: opacity 0.6s ease'
    ].join(';');

    document.body.appendChild(toast);

    const fadeDelay = Math.max(200, durationMs - 600);
    setTimeout(() => { toast.style.opacity = '0'; }, fadeDelay);
    setTimeout(() => toast.remove(), durationMs);
  }
  // ====================================================================
  // SECTION: Selection Mode
  // User selects/deselects content blocks via green overlays.
  // Supports: toggle, select-all, select-none, merge, unmerge.
  // ====================================================================
  function enterSelectionMode() {
    if (isSelectionMode) return;

    const response = findSelectedResponse();
    if (!response) {
      showStatus('No AI response found', 'error');
      return;
    }
    detectedBlocks = currentAdapter.getBlocks(response);
    
    if (detectedBlocks.length === 0) {
      showStatus('No content blocks detected', 'error');
      return;
    }

    isSelectionMode = true;
    selectedBlockIndices = new Set(detectedBlocks.map((_, i) => i));

    const toolbar = document.getElementById('ds-selection-toolbar');
    toolbar.classList.add('show');
    // Trigger slide-in animation on next frame
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        toolbar.classList.add('visible');
      });
    });
    document.querySelector('.ds-screenshot-btn').style.display = 'none';

    // Create overlays (all selected by default)
    detectedBlocks.forEach((block, index) => {
      addBlockOverlay(block, index, true);
    });

    updateSelectionCount();
    updateOverlayPositions();
    
    // Add throttled scroll listener (rAF-batched to avoid blocking scroll)
    window.addEventListener('scroll', scheduleOverlayUpdate, true);
    
    if (detectedBlocks[0]?.elements[0]) {
      detectedBlocks[0].elements[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  // Exit selection mode
  function exitSelectionMode() {
    isSelectionMode = false;
    detectedBlocks = [];
    selectedBlockIndices.clear();
    mergeSelectedIndices.clear();

    window.removeEventListener('scroll', scheduleOverlayUpdate, true);
    document.getElementById('ds-selection-toolbar').classList.remove('visible');
    document.getElementById('ds-selection-toolbar').classList.remove('show');
    document.querySelector('.ds-screenshot-btn').style.display = '';
    document.querySelectorAll('.ds-block-overlay').forEach(el => el.remove());
  }

  // Add overlay element
  function addBlockOverlay(block, index, isSelected) {
    const overlay = document.createElement('div');
    overlay.className = 'ds-block-overlay' + (isSelected ? ' selected' : '');
    overlay.dataset.index = index;
    overlay.setAttribute('role', 'button');
    overlay.setAttribute('aria-label', 'Block ' + (index + 1) + ', click to toggle, Ctrl+click to merge-select');
    overlay.setAttribute('aria-pressed', isSelected ? 'true' : 'false');

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

  function getOverlayMetrics(block) {
    const firstEl = block.elements[0];
    const lastEl = block.elements[block.elements.length - 1];
    const firstRect = firstEl.getBoundingClientRect();
    const lastRect = lastEl.getBoundingClientRect();

    let left = firstRect.left;
    let width = Math.max(firstRect.width, lastRect.width);

    if (isTableBlock(block)) {
      const contextEl = getBlockRenderContext(block);
      if (contextEl) {
        const contextRect = contextEl.getBoundingClientRect();
        left = contextRect.left;
        width = contextRect.width;
      }
    }

    return {
      left,
      top: firstRect.top,
      width,
      height: lastRect.bottom - firstRect.top
    };
  }

  // Throttled overlay position update using rAF.
  // Without this, every scroll pixel triggers getBoundingClientRect() for every block,
  // causing forced synchronous reflows that make scrolling extremely laggy.
  let overlayRafPending = false;
  function scheduleOverlayUpdate() {
    if (overlayRafPending) return;
    overlayRafPending = true;
    requestAnimationFrame(() => {
      overlayRafPending = false;
      if (!isSelectionMode) return;
      updateOverlayPositions();
    });
  }

  // Update overlay positions on scroll.
  // Uses transform: translate() for GPU-composited positioning.
  // This avoids triggering layout (left/top changes) per frame —
  // the compositor can move boxes independently of the main thread.
  function updateOverlayPositions() {
    const overlays = document.querySelectorAll('.ds-block-overlay');
    detectedBlocks.forEach((block, i) => {
      const overlay = overlays[i];
      if (!overlay) return;

      const metrics = getOverlayMetrics(block);

      overlay.style.width = (metrics.width + 16) + 'px';
      overlay.style.height = (metrics.height + 8) + 'px';
      overlay.style.transform = 'translate(' + (metrics.left - 8) + 'px, ' + (metrics.top - 4) + 'px)';
    });
  }

  // Toggle block selection (with Ctrl support for merge)
  function toggleBlockSelection(index, event) {
    const overlay = document.querySelector(`.ds-block-overlay[data-index="${index}"]`);
    const isCtrlClick = event?.ctrlKey;
    
    if (isCtrlClick) {
      // Ctrl+click: toggle merge selection (visual highlight)
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
      overlay?.setAttribute('aria-pressed', selectedBlockIndices.has(index) ? 'true' : 'false');
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
      showStatus('Ctrl+click 2+ adjacent blocks to merge', 'error');
      return;
    }
    
    const indices = Array.from(mergeSelectedIndices).sort((a, b) => a - b);
    
    // Check if indices are consecutive
    for (let i = 1; i < indices.length; i++) {
      if (indices[i] !== indices[i-1] + 1) {
        showSelectionToast('Can only merge adjacent blocks');
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
    
    // Rebuild overlays (respect current selection state)
    document.querySelectorAll('.ds-block-overlay').forEach(el => el.remove());
    detectedBlocks.forEach((block, i) => {
      addBlockOverlay(block, i, selectedBlockIndices.has(i));
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
      showStatus('Ctrl+click a merged block to unmerge', 'error');
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
    
    // Rebuild overlays (respect current selection state)
    document.querySelectorAll('.ds-block-overlay').forEach(el => el.remove());
    detectedBlocks.forEach((block, i) => {
      addBlockOverlay(block, i, selectedBlockIndices.has(i));
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
      const overlay = document.querySelector(`.ds-block-overlay[data-index="${i}"]`);
      overlay?.classList.add('selected');
      overlay?.setAttribute('aria-pressed', 'true');
    });
    updateSelectionCount();
  }

  function selectNoBlocks() {
    selectedBlockIndices.clear();
    document.querySelectorAll('.ds-block-overlay').forEach(el => {
      el.classList.remove('selected');
      el.setAttribute('aria-pressed', 'false');
    });
    updateSelectionCount();
  }

  function updateSelectionCount() {
    document.getElementById('ds-selection-count').textContent = 
      `${selectedBlockIndices.size}/${detectedBlocks.length}`;
  }

  // ====================================================================
  // SECTION: KaTeX Detection
  // ====================================================================

  function needsKatex(block) {
    return block.elements.some(el => el.querySelector?.('.katex'));
  }

  // ====================================================================
  // SECTION: Self-Contained Container Renderer
  // Builds a clean, self-styled DOM container from block innerHTML.
  // Skips html2canvas's CSS parsing hell by using only controlled styles.
  // ====================================================================

  /**
   * Calculate relative luminance from a CSS color string.
   * Supports rgb/rgba(), #rrggbb and #rgb forms. Returns 0..1.
   */
  function calcLuminance(colorStr) {
    if (!colorStr) return 0;
    let m = colorStr.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
    let r, g, b;
    if (m) {
      r = parseInt(m[1], 10); g = parseInt(m[2], 10); b = parseInt(m[3], 10);
    } else if ((m = colorStr.match(/#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i))) {
      r = parseInt(m[1], 16); g = parseInt(m[2], 16); b = parseInt(m[3], 16);
    } else if ((m = colorStr.match(/#([0-9a-f])([0-9a-f])([0-9a-f])/i))) {
      r = parseInt(m[1] + m[1], 16); g = parseInt(m[2] + m[2], 16); b = parseInt(m[3] + m[3], 16);
    } else {
      return 0;
    }
    return 0.299 * r / 255 + 0.587 * g / 255 + 0.114 * b / 255;
  }

  /**
   * Check if a CSS color string is "light" — i.e., would be hard to read on
   * a light background. Threshold (0.5) is symmetric with isColorDark().
   */
  function isLightColor(colorStr) {
    return calcLuminance(colorStr) >= 0.5;
  }

  /**
   * Bake computed color styles from a source element tree onto a cloned element tree.
   * Preserves syntax highlighting colors that would be lost when the clone is placed
   * in a self-contained container with the `all: unset` CSS reset.
   * Inline styles have the highest specificity, so they override `all: unset`.
   *
   * When isDarkTarget is false (light-mode screenshot), token colors that are
   * designed for a dark background (e.g., light-pink keywords) are automatically
   * remapped to dark equivalents suitable for a light background.
   */
  function bakeComputedColors(source, clone, isDarkTarget) {
    if (source.nodeType !== Node.ELEMENT_NODE || clone.nodeType !== Node.ELEMENT_NODE) return;

    const computedStyle = window.getComputedStyle(source);
    const color = computedStyle.color;

    if (isDarkTarget) {
      // Dark target: bake colors as-is (source is also dark → colors are correct)
      clone.style.color = color;
    } else {
      // Light target: if the source color is too light for a light bg, skip it
      // so the pre's default dark text color takes over instead.
      if (!isLightColor(color)) {
        clone.style.color = color;
      }
      // If color IS light (designed for dark bg), don't bake →
      // the element inherits pre's color (#24292f) which is readable.
    }

    // Also bake font-style and font-weight for syntax highlighting variations
    // (e.g., italic comments, bold keywords)
    if (computedStyle.fontStyle === 'italic') {
      clone.style.fontStyle = 'italic';
    }
    const fw = computedStyle.fontWeight;
    if (fw && fw !== 'normal' && fw !== '400') {
      clone.style.fontWeight = fw;
    }

    // Recurse into children (parallel walk of source and clone DOM trees)
    const srcKids = source.children;
    const dstKids = clone.children;
    const len = Math.min(srcKids.length, dstKids.length);
    for (let i = 0; i < len; i++) {
      bakeComputedColors(srcKids[i], dstKids[i], isDarkTarget);
    }
  }

  function buildSelfContainedContainer(block, targetWidth, bgColor) {
    const isDark = isColorDark(bgColor);
    const isCode = block.type === 'code';
    const hasKatex = needsKatex(block);

    // Two-layer structure:
    //   wrapper: off-screen positioning only (not passed to html-to-image)
    //   inner: visual styles + content (this is what html-to-image renders)
    // This avoids visibility:hidden or left:-10000px being serialized into SVG,
    // which would produce a blank image.
    const wrapper = document.createElement('div');
    Object.assign(wrapper.style, {
      position: 'fixed',
      left: '-10000px',
      top: '0',
      zIndex: '-1',
    });

    const inner = document.createElement('div');
    Object.assign(inner.style, {
      width: targetWidth + 'px',
      background: bgColor,
      color: isDark ? '#e5e5e5' : '#1f2937',
      padding: '16px',
      boxSizing: 'border-box',
    });

    // Minimal style overrides — no all:unset! The deep-cloned elements keep
    // their host-page classes and DOM structure. In onclone we inline all
    // same-origin stylesheets as <style> tags so html-to-image can read them
    // without SecurityError, and only remove cross-origin <link> tags.
    const style = document.createElement('style');
    style.textContent = `
      .cs-content {
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
        font-size: 15px;
        line-height: 1.75;
        color: ${isDark ? '#e5e5e5' : '#1f2937'};
        word-break: break-word;
        overflow-wrap: break-word;
      }
      .cs-content pre {
        white-space: pre;
        overflow: visible;
        max-height: none;
      }
      .cs-content pre code {
        white-space: inherit;
        max-height: none;
        display: block;
      }
      .cs-content table {
        border-collapse: collapse;
        width: 100%;
      }
      .cs-content th, .cs-content td {
        border: 1px solid ${isDark ? '#4b5563' : '#d1d5db'};
        padding: 6px 10px;
      }
      .cs-content th {
        background: ${isDark ? '#1f2937' : '#f9fafb'};
        font-weight: 600;
      }
      .cs-content img {
        max-width: 100%;
        height: auto;
      }
    `;

    const content = document.createElement('div');
    content.className = 'cs-content';

    if (isCode) {
      // Deep-clone the code element to preserve syntax highlighting spans,
      // then bake computed colors into inline styles.
      const codeEl = block.elements[0]?.querySelector('code') || block.elements[0];
      if (codeEl) {
        const clone = codeEl.cloneNode(true);
        bakeComputedColors(codeEl, clone, isDark);
        const pre = document.createElement('pre');
        pre.appendChild(clone);
        content.appendChild(pre);
      }
    } else {
      // Deep-clone each element to preserve full DOM structure, classes,
      // and nesting. This keeps ol/ul, blockquote, table, KaTeX, SVG
      // all working with their host-page CSS.
      for (const el of block.elements) {
        content.appendChild(el.cloneNode(true));
      }
    }

    // Remove scrollbar elements from tables (DeepSeek's .ds-scroll-area
    // includes custom scrollbars that show as gray bars in screenshots).
    // Use attribute prefix selectors to catch all __scrollbar, __track, __thumb, __gutter.
    content.querySelectorAll('[class*="scroll-area__scrollbar"], [class*="scroll-area__track"], [class*="scroll-area__thumb"], [class*="scroll-area__gutter"]').forEach(el => el.remove());
    // Make scroll areas and code blocks expand to full height/width.
    content.querySelectorAll('.ds-scroll-area, pre, .md-code-block').forEach(el => {
      el.style.maxHeight = 'none';
      el.style.maxWidth = 'none';
      el.style.overflow = 'visible';
      el.style.overflowX = 'visible';
      el.style.overflowY = 'visible';
    });

    inner.appendChild(style);
    inner.appendChild(content);

    // For KaTeX blocks, inline KaTeX CSS as a <style> tag (not <link>)
    // so onclone won't remove it. <link> tags are stripped because they
    // cause SecurityError when html-to-image reads cross-origin cssRules.
    if (hasKatex) {
      const katexStyle = document.createElement('style');
      katexStyle.dataset.katexCss = '1';
      inner.insertBefore(katexStyle, inner.firstChild);
    }

    wrapper.appendChild(inner);
    return { wrapper, inner, hasKatex };
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
    await doCapture(blocksToCapture);
  }

  // Main capture orchestrator: captures blocks one by one, then stitches
  async function doCapture(blocks) {
    document.getElementById('ds-col-dec').disabled = true;
    document.getElementById('ds-col-inc').disabled = true;
    document.getElementById('ds-start-capture').disabled = true;

    detectedBgColor = null;
    isCancelled = false;
    cachedOncloneCssText = null; // Reset CSS cache for fresh capture session
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

      const capturedBlocks = [];
      const captureStart = performance.now();
      for (let i = 0; i < blocks.length; i++) {
        if (isCancelled) {
          showStatus('Cancelled', 'error');
          return;
        }
        showStatus(`Capturing (${i + 1}/${blocks.length})...`, 'info');
        
        // Allow UI to update between captures
        await new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));
        
        try {
          const result = await captureWithRetry(blocks[i], maxWidth, blocks.length);
          capturedBlocks.push(result);
        } catch (err) {
          console.error('[ChatShot] Block', i + 1, 'FAILED:', err.message);
          throw err;
        }
      }
      DEBUG && console.log('[ChatShot] TOTAL capture all blocks:', (performance.now() - captureStart).toFixed(0) + 'ms', '(' + blocks.length + ' blocks)');

      if (isCancelled) {
        showStatus('Cancelled', 'error');
        return;
      }

      showStatus('Stitching images...', 'info');
      await new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));
      
      // Load platform logo for header
      const logoImg = await loadLogo();
      
      const finalCanvas = await stitchImages(capturedBlocks, logoImg, currentColumns);

      // Free compressed blobs and CSS cache
      for (const b of capturedBlocks) {
        if (b.blob) b.blob = null;
      }
      capturedBlocks.length = 0;
      cachedOncloneCssText = null;

      // Always download + copy to clipboard
      await downloadImage(finalCanvas);
      try {
        await copyImageToClipboard(finalCanvas);
        showStatus('Downloaded & copied to clipboard!', 'success');
      } catch (e) {
        DEBUG && console.warn('[ChatShot] Clipboard failed:', e);
        showStatus('Downloaded! (clipboard not supported)', 'success');
      }

    } catch (error) {
      console.error('[ChatShot] Error:', error);
      showStatus('Error: ' + error.message, 'error');
    } finally {
      document.getElementById('ds-col-dec').disabled = false;
      document.getElementById('ds-col-inc').disabled = false;
      document.getElementById('ds-start-capture').disabled = false;
      // Remove cancel button
      const cancelEl = document.getElementById('ds-capture-cancel');
      if (cancelEl) cancelEl.remove();
    }
  }

  function findSelectedResponse() {
    // Use stored DOM reference if still attached; else fall back to latest
    if (selectedResponseEl && document.contains(selectedResponseEl)) {
      return selectedResponseEl;
    }
    const responses = document.querySelectorAll(currentAdapter.responseSelector);
    return responses.length > 0 ? responses[responses.length - 1] : null;
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
    return calcLuminance(color) < 0.5;
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

  // Table & block type helpers for overlay metrics

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

  // ====== Image Inline ======
  function blobToDataURL(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('blobToDataURL failed'));
      reader.onload = () => resolve(String(reader.result || ''));
      reader.readAsDataURL(blob);
    });
  }

  function blobToImage(blob) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(blob);
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Failed to decode block image')); };
      img.src = url;
    });
  }

  async function inlineAllImages(container) {
    const imgs = Array.from(container.querySelectorAll('img'));
    if (imgs.length === 0) return;

    await Promise.all(imgs.map(async (img) => {
      let src = img.getAttribute('src') || '';
      if (!src || src.startsWith('data:')) return;

      if (src.startsWith('//')) src = 'https:' + src;
      if (!/^https?:\/\//i.test(src)) return;

      // Strategy 1: content script direct fetch
      try {
        const resp = await fetch(src, { mode: 'cors', credentials: 'include' });
        if (resp.ok) {
          const blob = await resp.blob();
          const dataUrl = await blobToDataURL(blob);
          if (dataUrl) { img.src = dataUrl; return; }
        }
      } catch { /* CORS failed, try strategy 2 */ }

      // Strategy 2: fetch via background script to bypass CORS
      try {
        const result = await new Promise((resolve) => {
          try {
            chrome.runtime.sendMessage({ type: 'fetchImage', url: src }, (resp) => {
              resolve(resp);
            });
          } catch { resolve(null); }
        });
        if (result && result.ok && result.base64) {
          const contentType = result.contentType || 'image/png';
          img.src = 'data:' + contentType + ';base64,' + result.base64;
          return;
        }
      } catch { /* All strategies failed, keep original src */ }
    }));

    // Wait for all images to decode
    await Promise.all(imgs.map(img =>
      (typeof img.decode === 'function' ? img.decode() : Promise.resolve()).catch(() => {})
    ));
  }

  // ====== Retry wrapper for capture ======
  const MAX_CAPTURE_RETRIES = 3;
  const RETRY_DELAY_MS = 300;

  async function captureWithRetry(block, targetWidth, totalBlocks, maxRetries) {
    if (maxRetries === undefined) maxRetries = MAX_CAPTURE_RETRIES;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        return await captureBlock(block, targetWidth, totalBlocks);
      } catch (err) {
        if (attempt === maxRetries - 1) throw err;
        const msg = (err && err.message || '').toLowerCase();
        if (/image|decode|network|load|taint/.test(msg)) {
          await new Promise(function(r) { setTimeout(r, RETRY_DELAY_MS); });
          continue;
        }
        throw err; // non-retryable error
      }
    }
  }

  // ====== XML illegal character sanitization ======
  // html-to-image uses SVG foreignObject, which serializes DOM to XML.
  // Control characters \x00-\x08 etc. are valid in HTML but illegal in XML 1.0,
  // causing silent rendering failure. Strip them before capture.
  const XML_ILLEGAL_CONTROL_CHAR_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F]/g;

  function stripXmlIllegalChars(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      // Note: no .test() guard — a /g regex has a stateful lastIndex and
      // would intermittently skip control chars across text nodes.
      node.nodeValue = node.nodeValue.replace(XML_ILLEGAL_CONTROL_CHAR_RE, '');
      return;
    }
    if (node.nodeType === Node.ELEMENT_NODE) {
      for (let i = 0; i < node.childNodes.length; i++) {
        stripXmlIllegalChars(node.childNodes[i]);
      }
    }
  }

  // ====== Router: all blocks → self-contained container ======
  // html-to-image uses SVG foreignObject — no CSS isolation needed.
  // All blocks (text, code, table, KaTeX) go through the same fast path.
  // totalBlocks controls pixelRatio: 1 block = 2.0x, 2-3 = 1.5x, 4+ = 1.25x
  async function captureBlock(block, targetWidth, totalBlocks) {
    if (!detectedBgColor) detectedBgColor = detectThemeBackground();
    const bgColor = detectedBgColor;
    const ratio = totalBlocks <= 1 ? 2.0 : totalBlocks <= 3 ? 1.5 : 1.25;
    return captureWithSelfContainer(block, targetWidth, bgColor, ratio);
  }

  // ====== Fast path: self-contained container ======
  async function captureWithSelfContainer(block, targetWidth, bgColor, pixelRatio) {
    if (!pixelRatio) pixelRatio = 1.5;
    const t0 = performance.now();
    const { wrapper, inner, hasKatex } = buildSelfContainedContainer(block, targetWidth, bgColor);
    document.body.appendChild(wrapper);
    DEBUG && console.log('[ChatShot] buildSelfContainedContainer:', (performance.now() - t0).toFixed(0) + 'ms');

    try {
      // For KaTeX blocks, fetch and inline the CSS as <style> content.
      // Must be done after appending to document so the <style> tag is in the live DOM.
      if (hasKatex) {
        const katexStyleEl = inner.querySelector('style[data-katex-css]');
        if (katexStyleEl && !katexStyleEl.textContent) {
          try {
            const resp = await fetch(chrome.runtime.getURL('lib/katex.min.css'));
            katexStyleEl.textContent = await resp.text();
          } catch (e) {
            DEBUG && console.warn('[ChatShot] Failed to load KaTeX CSS:', e);
          }
        }
      }

      // Inline all images before rendering
      const t1 = performance.now();
      await inlineAllImages(inner);
      DEBUG && console.log('[ChatShot] inlineAllImages:', (performance.now() - t1).toFixed(0) + 'ms');

      // Sanitize XML-illegal control chars for SVG foreignObject serialization
      const t2 = performance.now();
      stripXmlIllegalChars(inner);
      DEBUG && console.log('[ChatShot] stripXmlIllegalChars:', (performance.now() - t2).toFixed(0) + 'ms');

      const t3 = performance.now();
      const blob = await htmlToImage.toBlob(inner, {
        backgroundColor: bgColor,
        pixelRatio: pixelRatio,
        skipFonts: true,
        onclone: (clonedDoc, clonedEl) => {
          // Cache CSS collection — stylesheets don't change between blocks.
          if (cachedOncloneCssText === null) {
            let cssText = '';
            for (const sheet of document.styleSheets) {
              try {
                for (const rule of sheet.cssRules) {
                  // Skip @font-face (type 5) and @import (type 3).
                  // @import would trigger the browser to fetch external CSS
                  // containing @font-face rules, causing font decode errors.
                  if (rule.type === CSSRule.FONT_FACE_RULE || rule.type === CSSRule.IMPORT_RULE) continue;
                  cssText += rule.cssText + '\n';
                }
              } catch (e) { /* cross-origin, skip */ }
            }
            cachedOncloneCssText = cssText;
          }
          if (cachedOncloneCssText) {
            const inlinedStyle = clonedDoc.createElement('style');
            inlinedStyle.textContent = cachedOncloneCssText;
            clonedDoc.head.appendChild(inlinedStyle);
          }
          // Remove all external stylesheets — they'd cause SecurityError
          const sheets = clonedDoc.querySelectorAll('link[rel="stylesheet"]');
          sheets.forEach(s => s.remove());

          // Strip @font-face from existing <style> tags (host page KaTeX CSS
          // often injects @font-face via <style>, not <link>, and the rule-type
          // filter above only covers document.styleSheets).
          clonedDoc.querySelectorAll('style').forEach(s => {
            s.textContent = s.textContent.replace(/@font-face\s*\{[^}]*\}/g, '');
          });
        },
      });
      DEBUG && console.log('[ChatShot] htmlToImage.toBlob:', (performance.now() - t3).toFixed(0) + 'ms');
      if (!blob) throw new Error('html-to-image returned null blob');

      // Store compressed blob + dimensions instead of raw canvas pixels.
      // This cuts per-block memory from ~6MB (raw canvas) to ~250KB (PNG blob),
      //critical when capturing 5+ blocks to avoid OOM.
      const t4 = performance.now();
      const bitmap = await createImageBitmap(blob);
      const width = bitmap.width;
      const height = bitmap.height;
      bitmap.close();
      DEBUG && console.log('[ChatShot] createImageBitmap:', (performance.now() - t4).toFixed(0) + 'ms');
      DEBUG && console.log('[ChatShot] TOTAL captureWithSelfContainer:', (performance.now() - t0).toFixed(0) + 'ms');
      return { blob, width, height };
    } finally {
      wrapper.remove();
    }
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
    const isDark = isColorDark(bgColor);
    
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

  // Unified stitching: masonry layout with configurable column count (1-4).
  // capturedBlocks: Array<{ blob, width, height }>
  // Loads each compressed blob on-demand to minimize memory.
  async function stitchImages(capturedBlocks, logoImg, numCols) {
    if (capturedBlocks.length === 0) return null;

    const blockWidth = Math.max(...capturedBlocks.map(c => c.width));
    const gap = 4;        // gap between blocks (px)
    const dividerGap = 4; // space reserved for divider line
    const headerOffset = HEADER_HEIGHT;

    // Masonry layout: place each block in the shortest column
    const colHeights = new Array(numCols).fill(CONFIG.padding + headerOffset);
    const placements = []; // { blockIdx, x, y, col }

    for (let i = 0; i < capturedBlocks.length; i++) {
      const block = capturedBlocks[i];
      let minCol = 0;
      for (let c = 1; c < numCols; c++) {
        if (colHeights[c] < colHeights[minCol]) minCol = c;
      }
      const x = CONFIG.padding + minCol * (blockWidth + gap);
      const y = colHeights[minCol];
      placements.push({ blockIdx: i, x, y, col: minCol });
      colHeights[minCol] = y + block.height + dividerGap;
    }

    const totalWidth = CONFIG.padding * 2 + numCols * blockWidth + (numCols - 1) * gap;
    const totalHeight = Math.max(...colHeights) - dividerGap + CONFIG.padding;

    const finalCanvas = document.createElement('canvas');
    finalCanvas.width = totalWidth;
    finalCanvas.height = totalHeight;
    const ctx = finalCanvas.getContext('2d');
    const bgColor = detectedBgColor || '#ffffff';
    ctx.fillStyle = bgColor;
    ctx.fillRect(0, 0, totalWidth, totalHeight);

    drawHeader(ctx, totalWidth, logoImg, bgColor);

    // Draw blocks one at a time, decompressing blobs on-demand
    for (const { blockIdx, x, y } of placements) {
      const block = capturedBlocks[blockIdx];
      const img = await blobToImage(block.blob);
      ctx.drawImage(img, 0, 0, block.width, block.height, x, y, blockWidth, block.height);
      // Release the Image element immediately
      img.src = '';
    }

    // Draw divider lines between vertically adjacent blocks in the same column
    const isDark = isColorDark(bgColor);
    const lineColor = isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.1)';
    ctx.strokeStyle = lineColor;
    ctx.lineWidth = 1;

    // Group placements by column
    const columns = {};
    for (const p of placements) {
      if (!columns[p.col]) columns[p.col] = [];
      columns[p.col].push(p);
    }
    for (const colBlocks of Object.values(columns)) {
      colBlocks.sort((a, b) => a.y - b.y);
      for (let i = 0; i < colBlocks.length - 1; i++) {
        const block = capturedBlocks[colBlocks[i].blockIdx];
        const lineY = colBlocks[i].y + block.height + dividerGap / 2;
        const lineX = colBlocks[i].x;
        ctx.beginPath();
        ctx.moveTo(lineX, lineY);
        ctx.lineTo(lineX + blockWidth, lineY);
        ctx.stroke();
      }
    }

    return finalCanvas;
  }

  function downloadImage(canvas) {
    const now = new Date();
    const ts = now.getFullYear() + String(now.getMonth()+1).padStart(2,'0') +
      String(now.getDate()).padStart(2,'0') + '_' + String(now.getHours()).padStart(2,'0') +
      String(now.getMinutes()).padStart(2,'0') + String(now.getSeconds()).padStart(2,'0');
    const platformName = (currentAdapter?.displayName || currentAdapter?.name || 'chatshot')
      .toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const filename = platformName + '_' + ts + '.png';
    canvas.toBlob((blob) => {
      if (!blob) {
        console.error('[ChatShot] toBlob returned null');
        showStatus('Error: Failed to generate image', 'error');
        return;
      }
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }, 100);
    }, 'image/png');
  }

  async function copyImageToClipboard(canvas) {
    return new Promise((resolve, reject) => {
      canvas.toBlob(async (blob) => {
        if (!blob) { reject(new Error('toBlob failed')); return; }
        try {
          await navigator.clipboard.write([
            new ClipboardItem({ 'image/png': blob })
          ]);
          resolve();
        } catch (e) {
          reject(e);
        }
      }, 'image/png');
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();









