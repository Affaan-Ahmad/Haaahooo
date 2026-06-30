// Haaahooo service worker: push notifications + offline app-shell caching.

const CACHE = "haaahooo-cache-v1";
const APP_SHELL = [
  "/",
  "/manifest.webmanifest",
  "/icon-192.png",
  "/icon-512.png",
  "/apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(APP_SHELL).catch(() => undefined)),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  // Only handle our own origin. Supabase (data, auth, realtime, storage) and
  // any other API calls are left untouched so they never get stale-served.
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return;

  // Page navigations: network-first (always fresh when online), fall back to
  // the cached page / app shell when offline.
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
          return res;
        })
        .catch(() =>
          caches.match(req).then((cached) => cached || caches.match("/")),
        ),
    );
    return;
  }

  // Build assets + static files: cache-first (they're content-hashed).
  const isStatic =
    url.pathname.startsWith("/_next/static/") ||
    /\.(?:png|jpe?g|svg|webp|gif|ico|woff2?|css|js)$/.test(url.pathname);
  if (isStatic) {
    event.respondWith(
      caches.match(req).then(
        (cached) =>
          cached ||
          fetch(req).then((res) => {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
            return res;
          }),
      ),
    );
  }
});

self.addEventListener("push", function (event) {
  let data = {
    title: "Haaahooo",
    body: "New message",
    url: "/",
  };

  if (event.data) {
    try {
      data = event.data.json();
    } catch {
      data.body = event.data.text();
    }
  }

  event.waitUntil(
    self.registration.showNotification(data.title || "Haaahooo", {
      body: data.body || "New message",
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      tag: "haaahooo-message",
      data: { url: data.url || "/" },
    }),
  );
});

self.addEventListener("notificationclick", function (event) {
  event.notification.close();
  const targetUrl = event.notification.data?.url || "/";

  event.waitUntil(
    clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then(async function (clientList) {
        for (const client of clientList) {
          if ("navigate" in client) {
            await client.navigate(targetUrl);
          }
          if ("focus" in client) {
            return client.focus();
          }
        }

        if (clients.openWindow) {
          return clients.openWindow(targetUrl);
        }
      }),
  );
});
