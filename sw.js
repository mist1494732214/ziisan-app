/* 籽三手机版 · Service Worker（离线外壳）
   ────────────────────────────────────────────────────────────────
   两处环境都要能用：
     · 局域网（mobile.py 的 /m/）：路径带 /m/ 前缀
     · GitHub Pages（/ziisan-app/）：路径是子目录
   所以这里**一律用相对路径**，并且只处理同源请求。

   策略：
     · 外壳：cache-first（离线也能打开 App）
     · 内容：app.js 自己用 IndexedDB 缓存（GitHub 模式下跨域到 api.github.com，
             SW 不碰跨域请求，免得把令牌相关响应固化下来）
*/
const VER = 'zs-app-ed79de0511';
const SHELL = [
  './', './index.html', './app.js', './style.css', './manifest.webmanifest',
  './icon.svg', './vendor/marked.umd.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VER).then((c) => c.addAll(SHELL).catch(() => {}))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((ks) => Promise.all(ks.filter((k) => k !== VER).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;        // 跨域（GitHub API）交给页面自己管

  // 局域网模式的接口：network-first，离线回落缓存
  if (url.pathname.indexOf('/m/api/') >= 0) {
    e.respondWith(
      fetch(req).then((res) => {
        if (res && res.status === 200) {
          const copy = res.clone();
          caches.open(VER).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      }).catch(() => caches.match(req).then((hit) => hit || new Response(
        JSON.stringify({ error: '离线，且这一章还没缓存过' }),
        { status: 503, headers: { 'Content-Type': 'application/json; charset=utf-8' } }
      )))
    );
    return;
  }

  // 外壳：cache-first
  e.respondWith(
    caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      if (res && res.status === 200) {
        const copy = res.clone();
        caches.open(VER).then((c) => c.put(req, copy)).catch(() => {});
      }
      return res;
    }).catch(() => caches.match('./index.html')))
  );
});
