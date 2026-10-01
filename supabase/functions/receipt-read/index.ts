// ══════════════════════════════════════════════════════════════
//  Edge Function: receipt-read — ให้ AI (Claude) อ่านรูปบิล/ใบเสร็จ แล้วคืนค่าตามช่องในฟอร์มค่าใช้จ่าย
//  เรียกจากแอป: sb.functions.invoke('receipt-read', { body: { image, categories, payMethods } })
//    image       = data URL รูป (jpeg/png/webp) ที่ย่อแล้วฝั่งแอป
//    categories  = รายการหมวดหมู่ใน select#reno-cat (AI ต้องเลือกจากนี้เท่านั้น)
//    payMethods  = รายการวิธีชำระใน select#reno-pay
//
//  Secret ที่ต้องตั้งเอง: ANTHROPIC_API_KEY (Supabase Dashboard › Edge Functions › Secrets)
//  verify_jwt ปิด — ตรวจเองว่าเป็นคนที่ล็อกอินด้วย PIN แล้ว (เหมือน auction-push-notify)
// ══════════════════════════════════════════════════════════════
import Anthropic from "npm:@anthropic-ai/sdk";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const MEDIA_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"] as const;
type MediaType = typeof MEDIA_TYPES[number];

const SYSTEM = `คุณอ่านรูปบิล ใบเสร็จ ใบกำกับภาษี สลิปโอนเงิน หรือใบเสนอราคา ของงานรีโนเวท/ซื้อบ้าน แล้วกรอกข้อมูลลงฟอร์มบันทึกค่าใช้จ่าย
- date: วันที่บนเอกสารในรูปแบบ YYYY-MM-DD เป็นปี ค.ศ. (ถ้าเอกสารเป็น พ.ศ. ให้ลบ 543 เช่น 15/06/2568 → 2025-06-15) ถ้าไม่มีวันที่ให้ส่ง ""
- amount: ยอดที่จ่ายจริงทั้งใบ (ยอดสุทธิ / รวมทั้งสิ้น / Grand Total รวม VAT แล้ว หักส่วนลดแล้ว) เป็นตัวเลขล้วน ถ้าอ่านไม่ได้ให้ส่ง 0
- vendor: ชื่อร้าน บริษัท หรือช่างที่รับเงิน (สลิปโอนเงิน = ชื่อผู้รับโอน)
- description: สรุปสั้น ๆ ภาษาไทยว่าจ่ายค่าอะไร เช่น "ค่าสีทาภายนอก", "ค่ากระเบื้องห้องน้ำ", "ค่าแรงช่างไฟ" (ไม่เกิน 60 ตัวอักษร)
- category: เลือกหมวดที่ตรงที่สุดจากรายการที่ให้มาเท่านั้น
- payment: วิธีชำระจากรายการที่ให้มา (สลิปโอน = โอนเงิน, มีเลขบัตร = บัตรเครดิต) ถ้าไม่รู้ให้ส่ง ""
- items: รายการสินค้า/งานหลักบนบิล (สูงสุด 10 รายการ) พร้อมราคา ถ้าไม่มีให้ส่ง []
- confidence: high = อ่านชัดทุกช่องหลัก, medium = บางช่องเดา, low = รูปไม่ชัด/ไม่ใช่บิล
- note: ข้อสังเกตสั้น ๆ ถ้ามี (เช่น "รูปเบลอ ยอดอาจผิด", "เป็นใบเสนอราคา ยังไม่ใช่ใบเสร็จ") ไม่มีให้ส่ง ""`;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    // ── ต้องล็อกอินด้วย PIN แล้วเท่านั้น (กันคนนอกใช้ API key เปลือง) ──
    const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data: u } = jwt ? await sb.auth.getUser(jwt) : { data: null };
    if (!u?.user) return json({ ok: false, error: "unauthorized" }, 401);

    if (!Deno.env.get("ANTHROPIC_API_KEY")) {
      return json({ ok: false, code: "no_key", error: "ยังไม่ได้ตั้ง ANTHROPIC_API_KEY ใน Supabase › Edge Functions › Secrets" });
    }

    const { image, categories, payMethods } = await req.json();
    const m = /^data:(image\/[a-z]+);base64,(.+)$/.exec(String(image || ""));
    if (!m || !MEDIA_TYPES.includes(m[1] as MediaType)) return json({ ok: false, error: "รูปไม่ถูกต้อง (ต้องเป็น jpeg/png/webp)" }, 400);
    if (m[2].length > 7_000_000) return json({ ok: false, error: "รูปใหญ่เกินไป" }, 400);
    const cats = (Array.isArray(categories) ? categories : []).map(String).filter(Boolean).slice(0, 60);
    const pays = (Array.isArray(payMethods) ? payMethods : []).map(String).filter(Boolean).slice(0, 20);
    if (!cats.length) return json({ ok: false, error: "ไม่มีรายการหมวดหมู่" }, 400);

    const schema = {
      type: "object",
      properties: {
        date: { type: "string" },
        amount: { type: "number" },
        vendor: { type: "string" },
        description: { type: "string" },
        category: { type: "string", enum: cats },
        payment: { type: "string", enum: [...pays, ""] },
        items: {
          type: "array",
          items: {
            type: "object",
            properties: { name: { type: "string" }, amount: { type: "number" } },
            required: ["name", "amount"],
            additionalProperties: false,
          },
        },
        confidence: { type: "string", enum: ["high", "medium", "low"] },
        note: { type: "string" },
      },
      required: ["date", "amount", "vendor", "description", "category", "payment", "items", "confidence", "note"],
      additionalProperties: false,
    };

    const client = new Anthropic();
    const res = await client.beta.messages.create({
      model: "claude-opus-5-5",
      max_tokens: 4000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "low", format: { type: "json_schema", schema } },
      system: SYSTEM,
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: m[1] as MediaType, data: m[2] } },
          { type: "text", text: `หมวดหมู่ที่เลือกได้: ${cats.join(" | ")}\nวิธีชำระที่เลือกได้: ${pays.join(" | ")}\n\nอ่านบิลนี้แล้วกรอกข้อมูล` },
        ],
      }],
    });

    if (res.stop_reason === "refusal") return json({ ok: false, error: "AI ปฏิเสธการอ่านรูปนี้" });
    if (res.stop_reason === "max_tokens") return json({ ok: false, error: "AI ตอบไม่จบ ลองใหม่อีกครั้ง" });
    const text = res.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("");
    const data = JSON.parse(text);
    return json({ ok: true, data });
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) return json({ ok: false, code: "bad_key", error: "ANTHROPIC_API_KEY ไม่ถูกต้อง" });
    if (e instanceof Anthropic.RateLimitError) return json({ ok: false, error: "AI ถูกเรียกถี่เกินไป รอสักครู่แล้วลองใหม่" });
    if (e instanceof Anthropic.APIError) return json({ ok: false, error: `AI error ${e.status}: ${e.message}` }, 502);
    return json({ ok: false, error: String(e) }, 500);
  }
});
