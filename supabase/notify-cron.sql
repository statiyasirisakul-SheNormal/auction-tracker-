-- ══════════════════════════════════════════════════════════════
--  แจ้งเตือน LINE ก่อนวันนัดประมูล 3 วัน (item 6) — ตั้งเวลาอัตโนมัติ
--  รันใน Supabase SQL Editor ของโปรเจกต์ rjpzmaeiopiqtsjaksed (ครั้งเดียว)
-- ══════════════════════════════════════════════════════════════

-- 1) ตารางกันส่งซ้ำ (edge function เขียนบันทึกว่าเตือนอันไหนไปแล้ว)
CREATE TABLE IF NOT EXISTS auction_line_sent (
  key     TEXT PRIMARY KEY,
  sent_at TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE auction_line_sent DISABLE ROW LEVEL SECURITY;

-- 2) เปิด extension สำหรับตั้งเวลา + เรียก HTTP
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- 3) ตั้ง cron ให้เรียก edge function ทุกวัน 08:00 เวลาไทย (= 01:00 UTC)
--    ⚠️ แก้ 2 ค่าให้ตรงโปรเจกต์:
--       <PROJECT_REF>  = rjpzmaeiopiqtsjaksed
--       <ANON_OR_SERVICE_KEY> = anon key หรือ service_role key (ใช้เรียก function)
SELECT cron.schedule(
  'auction-line-notify-daily',
  '0 1 * * *',
  $$
  SELECT net.http_post(
    url     := 'https://<PROJECT_REF>.functions.supabase.co/auction-line-notify',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer <ANON_OR_SERVICE_KEY>'
    ),
    body    := '{}'::jsonb
  );
  $$
);

-- ── คำสั่งช่วยจัดการ ──
-- ดู cron ทั้งหมด:      SELECT * FROM cron.job;
-- ลบ cron ตัวนี้:       SELECT cron.unschedule('auction-line-notify-daily');
-- ล้างประวัติส่ง:       TRUNCATE auction_line_sent;
