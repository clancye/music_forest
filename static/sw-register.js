/* Registers the Music Forest service worker.
 *
 * Kept in its own same-origin file (not an inline <script>) so the strict CSP
 * landing in the H1.3 hardening pass needs no script nonce/hash. Registration is
 * feature-detected and best-effort: if the SW is unsupported or fails to register,
 * the app runs exactly as it does today (just without the offline shell / install).
 *
 * sw.js is served from the origin root (/sw.js) so its scope is the whole site
 * ("/") and it can handle top-level navigations, not just /static/.
 */
(function () {
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', function () {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(function (err) {
      // Non-fatal: log and carry on.
      console.warn('[pwa] service worker registration failed:', err);
    });
  });
})();
