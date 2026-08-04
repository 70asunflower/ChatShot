/*
 * ChatShot - Background Service Worker
 * Handles cross-origin image fetching for the inlineImages feature.
 * Content scripts cannot bypass CORS directly; this service worker
 * fetches images on their behalf using host_permissions (https scheme, any host).
 */

const FETCH_TIMEOUT_MS = 10000;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'fetchImage' && msg.url) {
    // Protocol whitelist: only fetch http/https (no file:, chrome:, data:…)
    if (!/^https?:\/\//i.test(msg.url)) {
      sendResponse({ ok: false });
      return;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const done = () => clearTimeout(timer);

    fetch(msg.url, { signal: controller.signal, credentials: 'include' })
      .then(resp => {
        done();
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        return resp.blob();
      })
      .then(blob => {
        const reader = new FileReader();
        reader.onload = () => {
          sendResponse({ ok: true, base64: reader.result.split(',')[1], contentType: blob.type });
        };
        reader.onerror = () => sendResponse({ ok: false });
        reader.readAsDataURL(blob);
      })
      .catch(() => {
        done();
        sendResponse({ ok: false });
      });
    return true; // keep sendResponse channel open for async
  }
});
