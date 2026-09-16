/* ==========================================================================
   Minimal service worker. Two jobs, deliberately kept small:
   1. Its mere presence (registered + has a fetch handler) is one of the
      technical requirements browsers check before offering "Install app" /
      the automatic add-to-home-screen prompt — manifest.json alone isn't
      enough in most browsers.
   2. Lets the app shell (this HTML file + icons + manifest) still open with
      no connection at all, not just the voice-capture offline queue inside
      it. Falls back to cache only when the network genuinely fails.

   Deliberately NOT caching /api/* — those need live data or the app's own
   online/offline handling (see the voice queue in index.html) to do the
   right thing; a stale cached API response would be worse than none.

   Bump CACHE_NAME (e.g. v2, v3...) whenever you want to force every
   installed copy to pick up a fresh shell instead of a stale cached one.
   ========================================================================== */
const CACHE_NAME = "founderos-shell-v1";
const SHELL_FILES = ["./", "./index.html", "./manifest.json"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL_FILES))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin) return; // let non-GET and cross-origin requests pass straight through
  if (url.pathname.startsWith("/api/")) return; // never cache API calls — see comment above

  event.respondWith(
    fetch(event.request)
      .then((networkResp) => {
        const copy = networkResp.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        return networkResp;
      })
      .catch(() => caches.match(event.request).then((cached) => cached || caches.match("./index.html")))
  );
});

/* --------------------------------------------------------------------------
   PUSH NOTIFICATIONS (focus/break session reminders, neglect nudges, etc.)
   The Worker (see worker.js) sends an encrypted push message; this is what
   actually turns it into something the person sees. `tag` lets a newer
   reminder replace an older still-showing one (e.g. session status
   updates) instead of piling up notifications.

   `category` (e.g. "timeup", "neglect", "ontrack", "complete") travels
   with the payload so the OPEN APP can play its own custom sound + voice
   announcement instead of just the OS's generic notification sound — see
   the postMessage broadcast below. A service worker has no Web Audio or
   speech synthesis access of its own (no window, nothing to play through),
   so when the app is fully closed, the person gets the plain OS
   notification sound only — the rich sound/voice needs the page alive
   somewhere to actually produce it.
   -------------------------------------------------------------------------- */
self.addEventListener("push", (event) => {
  let data = { title: "Founder OS", body: "", url: "./", category: "generic" };
  try{ if(event.data) data = Object.assign(data, event.data.json()); }catch(e){ /* malformed payload — fall back to the generic default above */ }

  event.waitUntil(
    Promise.all([
      self.registration.showNotification(data.title, {
        body: data.body,
        icon: "./icons/icon-192.png",
        badge: "./icons/icon-192.png",
        tag: data.tag || undefined,
        data: { url: data.url || "./" },
      }),
      self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
        clientList.forEach((client) => client.postMessage({ type: "founderos-push", category: data.category, title: data.title, body: data.body }));
      }),
    ])
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || "./";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ("focus" in client) return client.focus(); // reuse an already-open tab/window rather than opening a new one
      }
      if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
    })
  );
});
