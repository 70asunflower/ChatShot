/*
 * ChatShot - Background Service Worker
 * Handles cross-origin image fetching for the inlineImages feature.
 * Content scripts cannot bypass CORS directly; this service worker
 * fetches images on their behalf using the extension's permissions.
 */

const FETCH_TIMEOUT_MS = 10000;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'fetchImage' && msg.url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    fetch(msg.url, { signal: controller.signal })
      .then(resp => {
        clearTimeout(timer);
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        return resp.blob();
      })
      .then(blob => {
        const reader = new FileReader();
        reader.onload = () => {
          const base64 = reader.result.split(',')[1];
          sendResponse({ ok: true, base64, contentType: blob.type });
        };
        reader.onerror = () => sendResponse({ ok: false });
        reader.readAsDataURL(blob);
      })
      .catch(() => {
        clearTimeout(timer);
        sendResponse({ ok: false });
      });
    return true; // keep sendResponse channel open for async
  }
});
