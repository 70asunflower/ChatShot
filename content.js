(function() {
  'use strict';

  // Configuration
  const CONFIG = {
    maxRowWidth: 3000,
    blockGap: 10,
    rowGap: 20,
    backgroundColor: '#1a1a1a',
    padding: 20
  };

  // State variables
  let selectedResponseIndex = -1;
  let detectedBgColor = null;
  let isCancelled = false;
  
  // Selection mode state
  let isSelectionMode = false;
  let currentCaptureMode = 'horizontal';
  let detectedBlocks = [];
  let selectedBlockIndices = new Set();

  // Initialize
  function init() {
    if (document.querySelector('.ds-screenshot-btn')) return;

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

    document.addEventListener('click', (e) => {
      if (!e.target.closest('.ds-response-selector')) {
        document.getElementById('ds-response-list').classList.remove('show');
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

    const responses = document.querySelectorAll('.ds-markdown');
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

  // Enter selection mode
  function enterSelectionMode(mode) {
    if (isSelectionMode) return;

    const response = findSelectedResponse();
    if (!response) {
      showStatus('No DeepSeek response found', 'error');
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

    overlay.addEventListener('click', () => toggleBlockSelection(index));
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

  // Toggle block selection
  function toggleBlockSelection(index) {
    const overlay = document.querySelector(`.ds-block-overlay[data-index="${index}"]`);
    if (selectedBlockIndices.has(index)) {
      selectedBlockIndices.delete(index);
      overlay?.classList.remove('selected');
    } else {
      selectedBlockIndices.add(index);
      overlay?.classList.add('selected');
    }
    updateSelectionCount();
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

  // Confirm capture
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

  // Actual capture
  async function doCapture(blocks, mode) {
    const btnH = document.getElementById('ds-capture-h');
    const btnV = document.getElementById('ds-capture-v');
    btnH.disabled = true;
    btnV.disabled = true;

    detectedBgColor = null;
    isCancelled = false;

    // Show cancel button during capture
    const statusEl = document.getElementById('ds-status');
    const cancelBtn = document.createElement('button');
    cancelBtn.id = 'ds-capture-cancel';
    cancelBtn.className = 'ds-cancel-btn';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.style.marginTop = '6px';
    cancelBtn.onclick = () => { isCancelled = true; };
    statusEl.parentElement.appendChild(cancelBtn);

    try {
      showStatus(`Capturing ${blocks.length} blocks...`, 'info');

      const canvases = [];
      for (let i = 0; i < blocks.length; i++) {
        if (isCancelled) {
          showStatus('Cancelled', 'error');
          return;
        }
        showStatus(`Capturing (${i + 1}/${blocks.length})...`, 'info');
        const canvas = await captureBlock(blocks[i]);
        canvases.push(canvas);
      }

      if (isCancelled) {
        showStatus('Cancelled', 'error');
        return;
      }

      showStatus('Stitching images...', 'info');
      const finalCanvas = mode === 'horizontal' 
        ? stitchImagesHorizontal(canvases)
        : stitchImagesVertical(canvases);

      downloadImage(finalCanvas);
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
    const responses = document.querySelectorAll('.ds-markdown');
    if (responses.length === 0) return null;
    if (selectedResponseIndex === -1) return responses[responses.length - 1];
    if (selectedResponseIndex >= 0 && selectedResponseIndex < responses.length) {
      return responses[selectedResponseIndex];
    }
    return responses[responses.length - 1];
  }

  function detectBlocks(container) {
    const blocks = [];
    let currentBlock = null;
    const children = Array.from(container.children);

    for (const child of children) {
      const tagName = child.tagName.toLowerCase();
      if (tagName === 'h2' || tagName === 'h3') {
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
  }

  function detectThemeBackground() {
    const html = document.documentElement;
    const body = document.body;
    const isDarkMode = 
      html.classList.contains('dark') || body.classList.contains('dark') ||
      html.classList.contains('dark-mode') || body.classList.contains('dark-mode') ||
      html.getAttribute('data-theme') === 'dark' || body.getAttribute('data-theme') === 'dark' ||
      document.querySelector('[class*="dark"]') !== null ||
      isColorDark(window.getComputedStyle(body).backgroundColor);
    return isDarkMode ? '#1e1e1e' : '#ffffff';
  }

  function isColorDark(color) {
    if (!color || color === 'transparent' || color === 'rgba(0, 0, 0, 0)') return false;
    const match = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    if (!match) return false;
    const luminance = 0.299 * parseInt(match[1])/255 + 0.587 * parseInt(match[2])/255 + 0.114 * parseInt(match[3])/255;
    return luminance < 0.5;
  }

  async function captureBlock(block) {
    if (!detectedBgColor) detectedBgColor = detectThemeBackground();
    const bgColor = detectedBgColor;

    const tempContainer = document.createElement('div');
    tempContainer.style.cssText = `
      position: absolute; left: -9999px; top: 0;
      background: ${bgColor}; padding: 16px;
      width: fit-content; max-width: 800px;
    `;

    for (const el of block.elements) {
      const clone = el.cloneNode(true);
      copyElementStyles(el, clone);
      tempContainer.appendChild(clone);
    }

    document.body.appendChild(tempContainer);
    copyComputedStyles(tempContainer);

    try {
      return await html2canvas(tempContainer, {
        backgroundColor: bgColor, scale: 2, useCORS: true, logging: false
      });
    } finally {
      document.body.removeChild(tempContainer);
    }
  }

  function copyElementStyles(source, target) {
    const style = window.getComputedStyle(source);
    ['color', 'font-family', 'font-size', 'font-weight', 'line-height', 
     'background-color', 'border', 'padding', 'margin'].forEach(prop => {
      target.style[prop] = style.getPropertyValue(prop);
    });
    for (let i = 0; i < source.children.length && i < target.children.length; i++) {
      copyElementStyles(source.children[i], target.children[i]);
    }
  }

  function copyComputedStyles(container) {
    let cssText = '';
    try {
      for (const sheet of document.styleSheets) {
        try { for (const rule of sheet.cssRules) cssText += rule.cssText + '\n'; } catch (e) {}
      }
    } catch (e) {}
    const style = document.createElement('style');
    style.textContent = cssText;
    container.insertBefore(style, container.firstChild);
  }

  function stitchImagesHorizontal(canvases) {
    if (canvases.length === 0) return null;
    const rows = []; let currentRow = []; let currentRowWidth = 0;
    for (const canvas of canvases) {
      if (currentRowWidth + canvas.width > CONFIG.maxRowWidth && currentRow.length > 0) {
        rows.push(currentRow); currentRow = []; currentRowWidth = 0;
      }
      currentRow.push(canvas);
      currentRowWidth += canvas.width + CONFIG.blockGap;
    }
    if (currentRow.length > 0) rows.push(currentRow);

    let totalWidth = 0, totalHeight = CONFIG.padding * 2;
    for (const row of rows) {
      let rowWidth = CONFIG.padding * 2, rowHeight = 0;
      for (const canvas of row) {
        rowWidth += canvas.width + CONFIG.blockGap;
        rowHeight = Math.max(rowHeight, canvas.height);
      }
      totalWidth = Math.max(totalWidth, rowWidth - CONFIG.blockGap);
      totalHeight += rowHeight + CONFIG.rowGap;
    }
    totalHeight -= CONFIG.rowGap;

    const finalCanvas = document.createElement('canvas');
    finalCanvas.width = totalWidth;
    finalCanvas.height = totalHeight;
    const ctx = finalCanvas.getContext('2d');
    ctx.fillStyle = detectedBgColor || '#ffffff';
    ctx.fillRect(0, 0, totalWidth, totalHeight);

    let y = CONFIG.padding;
    for (const row of rows) {
      let x = CONFIG.padding, rowHeight = 0;
      for (const canvas of row) {
        ctx.drawImage(canvas, x, y);
        x += canvas.width + CONFIG.blockGap;
        rowHeight = Math.max(rowHeight, canvas.height);
      }
      y += rowHeight + CONFIG.rowGap;
    }
    return finalCanvas;
  }

  function stitchImagesVertical(canvases) {
    if (canvases.length === 0) return null;
    const gap = 2;
    let maxWidth = 0, totalHeight = CONFIG.padding * 2;
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
    ctx.fillStyle = detectedBgColor || '#ffffff';
    ctx.fillRect(0, 0, maxWidth, totalHeight);

    let y = CONFIG.padding;
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
    const filename = `deepseek_${ts}.png`;
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
