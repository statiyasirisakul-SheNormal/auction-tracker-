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

-- ปิด RLS (ใช้ user_key เป็น tenant แทน เหมือนระบบตอกบัตร)
ALTER TABLE auction_props      DISABLE ROW LEVEL SECURITY;
ALTER TABLE auction_expenses   DISABLE ROW LEVEL SECURITY;
ALTER TABLE auction_doc_types  DISABLE ROW LEVEL SECURITY;

-- เปิด realtime สำหรับทั้ง 3 ตาราง (ให้เครื่องอื่นอัปเดตอัตโนมัติ)
ALTER PUBLICATION supabase_realtime ADD TABLE auction_props;
ALTER PUBLICATION supabase_realtime ADD TABLE auction_expenses;
ALTER PUBLICATION supabase_realtime ADD TABLE auction_doc_types;
