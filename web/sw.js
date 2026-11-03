// Offline shell: cache-first for the app's own files. The model, voices and
// dictionary are cached separately by the worker (lightvoice-models-v1), so a
// new app version doesn't re-download 345 MB.
const SHELL = "lightvoice-shell-v6";
const SHELL_FILES = [
  "./", "index.html", "style.css", "manifest.webmanifest", "assets.json",
  "js/app.js", "js/worker.js", "js/engine.js", "js/text.js", "js/audio.js", "js/config.js", "js/storage.js", "js/clone.js", "js/voices.js",
  "g2p/sea_g2p_rs.js", "g2p/sea_g2p_rs_bg.wasm",
  // The page isn't controlled on its very first visit, so the runtime the worker
  // loads then would never pass through the fetch handler: precache it.
  "vendor/ort/ort.webgpu.min.mjs",
  "vendor/ort/ort-wasm-simd-threaded.asyncify.mjs",
  "vendor/ort/ort-wasm-simd-threaded.asyncify.wasm",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("lightvoice-shell-") && k !== SHELL).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Big, versioned runtime files: cache-first. onnxruntime picks its .wasm/.mjs at
// run time, so keep whichever one actually loads.
async function cacheFirst(req) {
  const hit = await caches.match(req, { ignoreSearch: true });
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) (await caches.open(SHELL)).put(req, res.clone());
  return res;
}

// The app's own small files: network-first so updates show up, cache when offline.
async function networkFirst(req) {
  try {
    const res = await fetch(req);
    if (res.ok) (await caches.open(SHELL)).put(req, res.clone());
    return res;
  } catch {
    const hit = await caches.match(req, { ignoreSearch: true });
    if (hit) return hit;
    throw new Error(`offline and not cached: ${req.url}`);
  }
}

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  // Model files are read by the worker straight from its own cache.
  if (url.pathname.includes("/models/") || url.pathname.includes("/sea_g2p.bin")) return;
  const big = url.pathname.includes("/vendor/ort/") || url.pathname.endsWith(".wasm");
  e.respondWith(big ? cacheFirst(e.request) : networkFirst(e.request));
});
