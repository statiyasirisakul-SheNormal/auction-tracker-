// Service Worker — ระบบจัดการทรัพย์ กรมบังคับคดี (item 13 PWA)
// เปิดแอปแบบ offline ได้: cache ตัวแอป (app shell) + รูปที่โหลดแล้ว
// ข้อมูลจริงอยู่ใน localStorage + sync Supabase เมื่อออนไลน์
const CACHE = 'auction-tracker-v1';
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon.svg',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Supabase / API — เอาสด ๆ เสมอ (อย่า cache ข้อมูล) ; ออฟไลน์ก็ปล่อยพัง (แอปมี localStorage)
  if (/supabase\.co/.test(url.host)) return;

  // การเปิดหน้า (navigation) → network-first, ล้มเหลวค่อยใช้ cache (ทำงาน offline)
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).then((res) => {
        caches.open(CACHE).then((c) => c.put('./index.html', res.clone()));
        return res;
      }).catch(() => caches.match('./index.html'))
    );
    return;
  }

  // อื่น ๆ (รูป, tiles แผนที่, leaflet cdn) → stale-while-revalidate
  e.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req).then((res) => {
        if (res && (res.status === 200 || res.type === 'opaque')) {
          const clone = res.clone();
          caches.open(CACHE).then((c) => c.put(req, clone)).catch(() => {});
        }
        return res;
      }).catch(() => cached);
      return cached || network;
    })
  );
});
