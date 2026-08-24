-- =============================================================
-- AUCTION TRACKER — Auth + RLS  (แพตเทิร์นเดียวกับระบบตอกบัตร)
-- รันแล้วในโปรเจกต์ rjpzmaeiopiqtsjaksed เมื่อ 2026-08-24
-- เก็บไฟล์นี้ไว้เพื่อให้สร้างใหม่ได้ถ้าต้องย้ายโปรเจกต์
--
-- ทำไมต้องมี: index.html ฝัง SB_URL + anon key ไว้ในโค้ด (เพื่อให้เปิด
-- เครื่องไหนก็ใช้ได้ทันที ไม่ต้องตั้งค่า) และ repo เป็น public
-- → anon key เปล่า ๆ ต้องทำอะไรไม่ได้เลย ต้องล็อกอินก่อนถึงเห็นข้อมูล
-- =============================================================

-- 1) ฟังก์ชันสร้าง/เปลี่ยน PIN ของเจ้าของระบบ
--    ครั้งแรกเรียกจาก SQL Editor ด้วย p_bootstrap => true
--    ครั้งต่อไปแอปเรียกผ่าน rpc('auction_set_pin') ซึ่งต้องล็อกอินอยู่แล้ว
CREATE OR REPLACE FUNCTION public.auction_set_pin(p_pin text, p_bootstrap boolean DEFAULT false)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','extensions','auth','pg_temp'
AS $$
DECLARE v_uid uuid; v_email text := 'owner@auction.local'; v_pw text;
BEGIN
  IF NOT p_bootstrap AND auth.role() IS DISTINCT FROM 'authenticated' THEN
    RAISE EXCEPTION 'ต้องล็อกอินก่อนถึงจะเปลี่ยน PIN ได้';
  END IF;
  IF p_pin !~ '^[0-9]{4,6}$' THEN
    RAISE EXCEPTION 'PIN ต้องเป็นตัวเลข 4-6 หลัก';
  END IF;

  v_pw := 'auction::' || p_pin;
  SELECT id INTO v_uid FROM auth.users WHERE email = v_email;

  IF v_uid IS NULL THEN
    v_uid := gen_random_uuid();
    INSERT INTO auth.users(
      instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,
      created_at,updated_at,raw_app_meta_data,raw_user_meta_data,
      confirmation_token,recovery_token,email_change_token_new,email_change,reauthentication_token)
    VALUES(
      '00000000-0000-0000-0000-000000000000',v_uid,'authenticated','authenticated',v_email,
      crypt(v_pw, gen_salt('bf')), now(), now(), now(),
      jsonb_build_object('provider','email','providers',jsonb_build_array('email')),
      jsonb_build_object('app','auction-tracker'),
      '','','','','');
    INSERT INTO auth.identities(provider_id,user_id,identity_data,provider,last_sign_in_at,created_at,updated_at)
    VALUES(v_uid::text,v_uid,
      jsonb_build_object('sub',v_uid::text,'email',v_email,'email_verified',true),
      'email',now(),now(),now());
  ELSE
    UPDATE auth.users
       SET encrypted_password = crypt(v_pw, gen_salt('bf')), updated_at = now()
     WHERE id = v_uid;
  END IF;
END $$;

REVOKE ALL ON FUNCTION public.auction_set_pin(text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.auction_set_pin(text, boolean) TO authenticated;

-- ตั้ง PIN ครั้งแรก (เปลี่ยนเลขก่อนรัน)
-- SELECT public.auction_set_pin('418902', true);

-- 2) RLS — อ่าน/เขียนได้เฉพาะคนที่ล็อกอินแล้ว
ALTER TABLE public.auction_props     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.auction_expenses  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.auction_doc_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.auction_data      ENABLE ROW LEVEL SECURITY;

-- policy "open" ของเวอร์ชันเก่าเปิดให้ role public (= รวม anon) เข้าถึงได้ทุกอย่าง
-- ถ้าไม่ลบ การเปิด RLS ข้างบนจะไม่มีผลอะไรเลย
DROP POLICY IF EXISTS "open" ON public.auction_props;
DROP POLICY IF EXISTS "open" ON public.auction_expenses;
DROP POLICY IF EXISTS "open" ON public.auction_doc_types;
DROP POLICY IF EXISTS "open" ON public.auction_data;

DROP POLICY IF EXISTS auction_props_auth     ON public.auction_props;
DROP POLICY IF EXISTS auction_expenses_auth  ON public.auction_expenses;
DROP POLICY IF EXISTS auction_doc_types_auth ON public.auction_doc_types;
DROP POLICY IF EXISTS auction_data_auth      ON public.auction_data;

CREATE POLICY auction_props_auth     ON public.auction_props     FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY auction_expenses_auth  ON public.auction_expenses  FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY auction_doc_types_auth ON public.auction_doc_types FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY auction_data_auth      ON public.auction_data      FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- 3) Storage — อัปโหลด/แก้/ลบ ต้องล็อกอิน
--    ส่วนการ "อ่าน" ยังเป็น public URL เหมือนเดิม เพราะรูปที่บันทึกไว้แล้ว
--    เก็บเป็น /object/public/... ถ้าปิดตรงนี้ URL เดิมทั้งหมดจะพังทันที
--    (path เป็นสุ่ม เดาไม่ได้ และ list ไม่ได้ — ถ้าจะรัดกุมกว่านี้ต้องเปลี่ยนไปใช้ signed URL)
DROP POLICY IF EXISTS "auction_images_write"  ON storage.objects;
DROP POLICY IF EXISTS "auction_images_update" ON storage.objects;
DROP POLICY IF EXISTS "auction_images_delete" ON storage.objects;
CREATE POLICY "auction_images_write"  ON storage.objects FOR INSERT TO authenticated WITH CHECK (bucket_id = 'auction-images');
CREATE POLICY "auction_images_update" ON storage.objects FOR UPDATE TO authenticated USING (bucket_id = 'auction-images');
CREATE POLICY "auction_images_delete" ON storage.objects FOR DELETE TO authenticated USING (bucket_id = 'auction-images');
