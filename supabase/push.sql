-- ══════════════════════════════════════════════════════════════
--  แจ้งเตือนผ่านเครื่อง (Web Push) — แทนการส่ง LINE
--  รันแล้วในโปรเจกต์ rjpzmaeiopiqtsjaksed เมื่อ 2026-10-01
--  เก็บไฟล์นี้ไว้เพื่อสร้างใหม่ได้ถ้าต้องย้ายโปรเจกต์
-- ══════════════════════════════════════════════════════════════

-- 1) เครื่องที่กด "เปิดแจ้งเตือน" แล้ว (1 แถว = 1 เครื่อง/เบราว์เซอร์)
CREATE TABLE IF NOT EXISTS public.push_subscriptions (
  endpoint    TEXT PRIMARY KEY,
  p256dh      TEXT NOT NULL,
  auth        TEXT NOT NULL,
  device      TEXT,
  user_agent  TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  last_ok_at  TIMESTAMPTZ
);
ALTER TABLE public.push_subscriptions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS push_subscriptions_auth ON public.push_subscriptions;
CREATE POLICY push_subscriptions_auth ON public.push_subscriptions
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- 2) กันส่งซ้ำ (key = propId:นัด:วันที่:เหลือกี่วัน)
CREATE TABLE IF NOT EXISTS public.push_sent (
  key     TEXT PRIMARY KEY,
  sent_at TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE public.push_sent ENABLE ROW LEVEL SECURITY;   -- ไม่มี policy = เฉพาะ service role

-- 3) ค่าลับฝั่งเซิร์ฟเวอร์ (VAPID private key, cron secret)
--    เปิด RLS แต่ไม่มี policy → anon/authenticated อ่านไม่ได้ อ่านได้เฉพาะ service role ใน edge function
CREATE TABLE IF NOT EXISTS public.push_config (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
ALTER TABLE public.push_config ENABLE ROW LEVEL SECURITY;

-- 4) ใส่ค่า (สร้าง VAPID key ใหม่ได้ด้วย WebCrypto ECDSA P-256 แล้ว export เป็น JWK)
-- INSERT INTO public.push_config(key,value) VALUES
--   ('vapid_private_jwk', '{"kty":"EC","crv":"P-256","x":"…","y":"…","d":"…"}'),
--   ('vapid_subject',     'https://statiyasirisakul-shenormal.github.io/auction-tracker-/'),
--   ('cron_secret',       encode(gen_random_bytes(24),'hex'))
-- ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

-- 5) เลิกใช้ LINE + ตั้งเวลาเตือนผ่านเครื่อง ทุกวัน 08:00 เวลาไทย (= 01:00 UTC)
-- SELECT cron.unschedule('auction-line-notify-daily');
SELECT cron.schedule(
  'auction-push-notify-daily',
  '0 1 * * *',
  $$
  SELECT net.http_post(
    url     := 'https://rjpzmaeiopiqtsjaksed.supabase.co/functions/v1/auction-push-notify',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'x-cron-secret', (SELECT value FROM public.push_config WHERE key = 'cron_secret')
    ),
    body    := '{"action":"run"}'::jsonb
  );
  $$
);

-- ── คำสั่งช่วยจัดการ ──
-- ดูเครื่องที่รับแจ้งเตือน:  SELECT device, created_at, last_ok_at FROM push_subscriptions;
-- ดูประวัติส่ง:            SELECT * FROM push_sent ORDER BY sent_at DESC LIMIT 50;
-- ดูผล cron:               SELECT * FROM net._http_response ORDER BY created DESC LIMIT 5;
