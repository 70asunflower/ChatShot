/*
 * ChatShot - Background Service Worker
 * Handles cross-origin image fetching for the inlineImages feature.
 * Content scripts cannot bypass CORS directly; this service worker
 * fetches images on their behalf using the extension's permissions.
 */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'fetchImage' && msg.url) {
    fetch(msg.url)
      .then(resp => resp.blob())
      .then(blob => {
        const reader = new FileReader();
        reader.onload = () => {
          var base64 = reader.result.split(',')[1];
          sendResponse({ ok: true, base64: base64, contentType: blob.type });
        };
        reader.onerror = () => sendResponse({ ok: false });
        reader.readAsDataURL(blob);
      })
      .catch(() => sendResponse({ ok: false }));
    return true; // keep sendResponse channel open for async
  }
});
