/* Service worker for live-tech-news PWA.
 * Strategy:
 *   - App shell (HTML/CSS/JS/icons/manifest): cache-first with background
 *     revalidation. Keeps the app instant on launch, updates on next visit.
 *   - Data snapshot (data/news.json): network-first, falling back to cache
 *     when offline so you still see the last known headlines.
 */
const VERSION = "ltn-v2-2026-07-06a";
const SHELL_CACHE = "ltn-shell-" + VERSION;
const DATA_CACHE  = "ltn-data-" + VERSION;

const SHELL_ASSETS = [
  "./",
  "./index.html",
  "./assets/css/style.css",
  "./assets/js/app.js",
  "./assets/icons/icon.svg",
  "./assets/icons/icon-192.png",
  "./assets/icons/icon-512.png",
  "./manifest.webmanifest",
  "https://cdn.jsdelivr.net/npm/fuse.js@7.0.0/dist/fuse.min.js"
];

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) =>
      // Best-effort: don't fail install if any single asset 404s.
      Promise.all(SHELL_ASSETS.map((u) =>
        cache.add(new Request(u, { cache: "reload" })).catch(() => null)
      ))
    )
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys.filter((k) => k !== SHELL_CACHE && k !== DATA_CACHE).map((k) => caches.delete(k))
    );
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);

  // Data snapshot: network-first, cache fallback.
  if (url.pathname.endsWith("/data/news.json")) {
    event.respondWith(networkFirst(req, DATA_CACHE));
    return;
  }

  // HTML + JS + CSS: network-first so code fixes propagate immediately;
  // fall back to cache when offline. This prevents "stuck PWA on old code"
  // bugs that are extremely painful to diagnose on iOS.
  const isShellCode =
    url.origin === self.location.origin &&
    (req.mode === "navigate" ||
     url.pathname.endsWith(".html") ||
     url.pathname.endsWith(".js") ||
     url.pathname.endsWith(".css") ||
     url.pathname.endsWith(".webmanifest"));
  if (isShellCode) {
    event.respondWith(networkFirst(req, SHELL_CACHE));
    return;
  }

  // Other same-origin (icons, fonts): cache-first with background revalidate.
  if (url.origin === self.location.origin) {
    event.respondWith(cacheFirst(req, SHELL_CACHE));
    return;
  }

  // Cross-origin (Fuse.js CDN): cache-first.
  event.respondWith(cacheFirst(req, SHELL_CACHE));
});

async function networkFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(req, { cache: "no-store" });
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  } catch (_) {
    const hit = await cache.match(req);
    if (hit) return hit;
    return new Response(
      JSON.stringify({ generated_at: null, lanes: { gadgets: [], innovation: [], ai: [], science: [] }, meta: { offline: true } }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }
}

async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  if (hit) {
    // Revalidate in background, don't block response.
    fetch(req).then((res) => { if (res && res.ok) cache.put(req, res.clone()); }).catch(() => {});
    return hit;
  }
  try {
    const res = await fetch(req);
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  } catch (_) {
    return new Response("", { status: 504 });
  }
}
