// Service Worker — ระบบจัดการทรัพย์ กรมบังคับคดี (PWA + แจ้งเตือน Web Push)
// เปิดแอปแบบ offline ได้: cache ตัวแอป (app shell) + รูปที่โหลดแล้ว
// ข้อมูลจริงอยู่ใน localStorage + sync Supabase เมื่อออนไลน์
const CACHE = 'auction-tracker-v6';
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon.svg',
  './icon-192.png',
  './icon-512.png',
];

self.addEventListener('install', (e) => {
  // ดึงไฟล์สดจากเน็ต (ข้าม HTTP cache) ตอนติดตั้ง SW ใหม่
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => Promise.all(SHELL.map((u) => fetch(u, { cache: 'reload' }).then((r) => c.put(u, r)).catch(() => {}))))
      .then(() => self.skipWaiting())
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
  // จัดเส้นทาง (OSRM) / หาพิกัด (Nominatim) — ต้องสดทุกครั้ง ไม่เก็บ cache
  if (/router\.project-osrm\.org|nominatim\.openstreetmap\.org/.test(url.host)) return;

  // การเปิดหน้า (navigation) → network-first + ข้าม HTTP cache เสมอ (ได้ตัวใหม่ทันที)
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req, { cache: 'reload' }).then((res) => {
        caches.open(CACHE).then((c) => c.put('./index.html', res.clone()));
        return res;
      }).catch(() => caches.match('./index.html') || caches.match('./'))
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

// ── แจ้งเตือนผ่านเครื่อง (Web Push) ─────────────────────────────
// เซิร์ฟเวอร์ (edge function auction-push-notify) ส่ง JSON { title, body, tag, url, propId }
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { d = { body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || 'ระบบจัดการทรัพย์', {
    body: d.body || '',
    tag: d.tag || undefined,
    icon: './icon-192.png',
    badge: './icon-192.png',
    lang: 'th',
    data: { url: d.url || './index.html', propId: d.propId || '' },
  }));
});

// แตะแจ้งเตือน → เปิดแอป (ถ้าเปิดอยู่แล้วก็สลับไปหน้านั้น) แล้วกางการ์ดทรัพย์นั้นให้
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const { url, propId } = e.notification.data || {};
  const target = new URL(url || './index.html', self.registration.scope).href;
  e.waitUntil((async () => {
    const wins = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) {
      if (w.url.startsWith(self.registration.scope)) {
        await w.focus();
        if (propId) w.postMessage({ type: 'open-prop', propId });
        return;
      }
    }
    await clients.openWindow(target);
  })());
});

// เบราว์เซอร์เปลี่ยน subscription เอง (หมดอายุ/รีเซ็ต) → บอกหน้าแอปให้ลงทะเบียนใหม่ตอนเปิดครั้งถัดไป
self.addEventListener('pushsubscriptionchange', () => {
  clients.matchAll({ type: 'window' }).then((ws) => ws.forEach((w) => w.postMessage({ type: 'resubscribe' })));
});
