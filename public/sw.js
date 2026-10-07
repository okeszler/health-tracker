// Minimaler Service Worker -- nur fürs "Installieren" (Add to Home Screen) und
// App-Shell-Offline-Fallback. /api/* wird nie gecacht, damit Vitals/Blutwerte/
// Health-Sync-Daten immer frisch vom Server kommen.

const CACHE = "health-tracker-shell-v3";
const SHELL_URLS = [
  "/",
  "/manifest.json",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL_URLS)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return; // nie cachen -- immer live

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((res) => {
          // nur die echte App cachen -- nicht die Login-Seite (abgelaufene Session)
          // oder Fehlerseiten, sonst zeigt die App offline genau die an
          if (res.ok && !res.headers.get("X-Login-Page")) {
            const copy = res.clone();
            caches.open(CACHE).then((cache) => cache.put("/", copy));
          }
          return res;
        })
        .catch(() => caches.match("/"))
    );
    return;
  }

  event.respondWith(
    caches.match(request).then(
      (cached) =>
        cached ||
        fetch(request).then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((cache) => cache.put(request, copy));
          }
          return res;
        })
    )
  );
});
