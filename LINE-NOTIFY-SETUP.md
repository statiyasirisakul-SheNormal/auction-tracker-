# แจ้งเตือน LINE ก่อนวันนัดประมูล 3 วัน — วิธีติดตั้ง (item 6)

ระบบนี้ยิงข้อความเข้ากลุ่ม/แชท LINE อัตโนมัติ **3 วันก่อนวันนัดที่เลือกไว้ (target round)** ของแต่ละทรัพย์ —
ทำงานฝั่งเซิร์ฟเวอร์ Supabase จึงเตือนได้แม้ไม่ได้เปิดแอป

โปรเจกต์ Supabase: **`rjpzmaeiopiqtsjaksed`** (โปรเจกต์เดียวกับที่แอปsync ข้อมูลอยู่)

---

## สิ่งที่ต้องเตรียม
1. **LINE Messaging API channel** (จาก https://developers.line.biz) → เอา **Channel access token**
2. **ปลายทาง** ที่จะส่ง (`groupId` ของกลุ่ม หรือ `userId`) — ตัวเดียวกับที่ระบบตอกบัตรใช้ก็ได้
3. ติดตั้ง [Supabase CLI](https://supabase.com/docs/guides/cli) แล้ว `supabase login`

---

## ขั้นตอน

### 1. สร้างตาราง + ตั้ง cron
เปิด **Supabase → SQL Editor** แล้วรันไฟล์ [`supabase/notify-cron.sql`](supabase/notify-cron.sql)
(อย่าลืมแก้ `<PROJECT_REF>` = `rjpzmaeiopiqtsjaksed` และ `<ANON_OR_SERVICE_KEY>` ในไฟล์ก่อนรัน)

### 2. ตั้งค่า secrets ของ Edge Function
```bash
supabase link --project-ref rjpzmaeiopiqtsjaksed

supabase secrets set \
  SB_URL=https://rjpzmaeiopiqtsjaksed.supabase.co \
  SB_SERVICE_ROLE=<service_role key> \
  LINE_CHANNEL_ACCESS_TOKEN=<channel token> \
  LINE_TARGET_ID=<groupId หรือ userId> \
  NOTIFY_DAYS_BEFORE=3
```
> หา `service_role key` ได้ที่ Supabase → Project Settings → API

### 3. Deploy Edge Function
```bash
supabase functions deploy auction-line-notify --no-verify-jwt
```

### 4. ทดสอบยิงเลย (ไม่ต้องรอ cron)
```bash
curl -X POST https://rjpzmaeiopiqtsjaksed.functions.supabase.co/auction-line-notify \
  -H "Authorization: Bearer <ANON_OR_SERVICE_KEY>"
```
ผลลัพธ์ `{"ok":true,"sent":N,...}` — `sent` คือจำนวนข้อความที่ส่ง
(จะส่งเฉพาะทรัพย์ที่ target round เหลือ **3 วันพอดี** และยังไม่เคยเตือน)

---

## การทำงาน
- cron รันทุกวัน **08:00 น. เวลาไทย**
- เตือนเฉพาะทรัพย์ที่:
  - เปิดสวิตช์ 🔔 ในแอป (ค่าเริ่มต้นเปิด)
  - มีวันที่ในนัดที่เลือก (target round)
  - สถานะยังไม่ใช่ "ขายแล้ว/ไม่ได้ทรัพย์"
  - เหลือ **3 วันพอดี** ถึงวันนัด และยังไม่เคยส่ง (กันซ้ำด้วยตาราง `auction_line_sent`)

## ปรับแต่ง
- อยากเตือนกี่วันก่อน → เปลี่ยน `NOTIFY_DAYS_BEFORE` (เช่น `1` = ก่อน 1 วัน)
- อยากเตือนหลายจังหวะ (เช่น 3 วัน + 1 วัน) → ตั้ง cron/secrets สองชุด หรือแก้ให้ loop หลายค่าใน `index.ts`
- เปลี่ยนเวลาส่ง → แก้ `'0 1 * * *'` ใน notify-cron.sql (เป็น UTC)
