-- =============================================
-- AUCTION TRACKER — Per-entity tables migration
-- คัดลอกทั้งหมดวางใน Supabase SQL Editor แล้วกด RUN
-- (ทำครั้งเดียว ในโปรเจกต์ rjpzmaeiopiqtsjaksed.supabase.co)
-- =============================================

CREATE TABLE IF NOT EXISTS auction_props (
  id         TEXT PRIMARY KEY,
  user_key   TEXT NOT NULL,
  data       JSONB NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS auction_props_user_idx ON auction_props(user_key);

CREATE TABLE IF NOT EXISTS auction_expenses (
  id         TEXT PRIMARY KEY,
  user_key   TEXT NOT NULL,
  prop_id    TEXT,
  data       JSONB NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS auction_expenses_user_idx ON auction_expenses(user_key);

CREATE TABLE IF NOT EXISTS auction_doc_types (
  id         TEXT PRIMARY KEY,
  user_key   TEXT NOT NULL,
  name       TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS auction_doc_types_user_idx ON auction_doc_types(user_key);

-- RLS: ดูไฟล์ auth_rls.sql (อย่าปิด RLS ตรงนี้)
-- เวอร์ชันก่อนหน้าเคย DISABLE RLS ไว้ ทำให้ใครก็ตามที่เห็น anon key ใน source
-- อ่าน/ลบข้อมูลได้หมด — ตอนนี้เปลี่ยนไปใช้ Supabase Auth (PIN) + RLS แล้ว

-- เปิด realtime สำหรับทั้ง 3 ตาราง (ให้เครื่องอื่นอัปเดตอัตโนมัติ)
-- ใช้ DO block กัน error ถ้าเคยเพิ่มไปแล้ว (รันซ้ำได้)
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['auction_props','auction_expenses','auction_doc_types'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = t
    ) THEN
      EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE %I', t);
    END IF;
  END LOOP;
END $$;

-- =============================================
-- STORAGE BUCKET สำหรับรูปภาพ (item 12)
-- เก็บรูปทรัพย์/บิล เป็นไฟล์ใน Storage แทน base64 ใน jsonb
-- (กัน localStorage/แถว jsonb บวมจนเต็ม)
-- =============================================
INSERT INTO storage.buckets (id, name, public)
VALUES ('auction-images', 'auction-images', true)
ON CONFLICT (id) DO NOTHING;

-- อ่านได้สาธารณะ (รูป public URL) + อัปโหลด/แก้/ลบด้วย anon key (แยก tenant ด้วย path = userKey/)
DROP POLICY IF EXISTS "auction_images_read"   ON storage.objects;
DROP POLICY IF EXISTS "auction_images_write"  ON storage.objects;
DROP POLICY IF EXISTS "auction_images_update" ON storage.objects;
DROP POLICY IF EXISTS "auction_images_delete" ON storage.objects;
CREATE POLICY "auction_images_read"   ON storage.objects FOR SELECT USING (bucket_id = 'auction-images');
CREATE POLICY "auction_images_write"  ON storage.objects FOR INSERT WITH CHECK (bucket_id = 'auction-images');
CREATE POLICY "auction_images_update" ON storage.objects FOR UPDATE USING (bucket_id = 'auction-images');
CREATE POLICY "auction_images_delete" ON storage.objects FOR DELETE USING (bucket_id = 'auction-images');
