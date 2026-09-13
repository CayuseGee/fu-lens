// 符镜 · Service Worker（PWA 离线缓存）
// 更新流程：每次改动前端文件后必须 ① 修改下方 CACHE 版本号（vN → vN+1）
//           ② index.html 中 styles.css/app.js 的 ?v=N 与 app.js 内模块 import 的 ?v=N
//           同步递增 —— 三处版本号不一致会导致 SW/HTTP 缓存返回旧代码（重要坑）。
// 策略：install 时预缓存 ASSETS（含 ORT WASM 与 ONNX 模型，约 47MB）；
//       fetch 走 network-first，失败回退缓存 —— 手机断网仍可完整识别。
// 服务端已设 Cache-Control: no-cache，配合版本化 URL 保证在线始终最新。
const CACHE = "fu-lens-v25";
const ASSETS = [
  "/", "/styles.css?v=25", "/app.js?v=25", "/fu.js?v=25", "/tiles.js?v=25", "/yolo.js?v=25", "/yaku.js?v=25",
  "/manifest.webmanifest", "/icon.svg", "/icon-192.png", "/icon-512.png",
  "/vendor/ort.min.js", "/vendor/ort-wasm-simd-threaded.wasm",
  "/vendor/ort-wasm-simd-threaded.mjs", "/vendor/ort-wasm-simd-threaded.jsep.wasm",
  "/vendor/ort-wasm-simd-threaded.jsep.mjs",
  "/models/nano/mahjong-yolon-best.onnx",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))));
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET" || new URL(event.request.url).pathname.startsWith("/api/")) return;
  event.respondWith(fetch(event.request).then((response) => {
    const copy = response.clone();
    caches.open(CACHE).then((cache) => cache.put(event.request, copy));
    return response;
  }).catch(() => caches.match(event.request)));
});
