// Finora service worker — makes the app installable ("Add to Home Screen") and
// lets it open with no network by caching the app shell (this HTML file, the
// manifest, and the icons). Cross-origin requests (Supabase, Google Sign-In,
// AdSense) are intentionally left alone below — those are optional features
// that already fail gracefully in the app itself when there's no network;
// this service worker only controls whether the app *opens* offline.
//
// Bump CACHE_NAME whenever this file changes so old caches get cleaned up.
const CACHE_NAME = "finora-shell-v1";
const APP_SHELL = [
  "/",
  "/index.html",
  "/manifest.json",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/icon-maskable-512.png"
];

self.addEventListener("install", function (event) {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(function (cache) { return cache.addAll(APP_SHELL); })
      .catch(function () { /* one asset failing to precache shouldn't block install */ })
  );
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches.keys()
      .then(function (keys) {
        return Promise.all(keys.filter(function (k) { return k !== CACHE_NAME; }).map(function (k) { return caches.delete(k); }));
      })
      .then(function () { return self.clients.claim(); })
  );
});

self.addEventListener("fetch", function (event) {
  var req = event.request;
  if (req.method !== "GET") return;

  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // let cross-origin requests through untouched

  // The app shell itself: try the network first (so anyone online always gets
  // the latest deployed version — this file changes often), and only fall back
  // to whatever's cached when the network request fails.
  if (req.mode === "navigate" || url.pathname === "/" || url.pathname === "/index.html") {
    event.respondWith(
      fetch(req)
        .then(function (res) {
          var copy = res.clone();
          caches.open(CACHE_NAME).then(function (cache) { cache.put(req, copy); });
          return res;
        })
        .catch(function () {
          return caches.match(req).then(function (cached) { return cached || caches.match("/index.html"); });
        })
    );
    return;
  }

  // Everything else same-origin (manifest, icons): cache-first, filling the
  // cache in the background the first time something is requested.
  event.respondWith(
    caches.match(req).then(function (cached) {
      if (cached) return cached;
      return fetch(req).then(function (res) {
        var copy = res.clone();
        caches.open(CACHE_NAME).then(function (cache) { cache.put(req, copy); });
        return res;
      });
    })
  );
});
