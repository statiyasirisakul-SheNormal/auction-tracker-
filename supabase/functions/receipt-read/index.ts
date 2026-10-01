// ══════════════════════════════════════════════════════════════
//  Edge Function: receipt-read — ให้ AI อ่านรูปบิล/ใบเสร็จ แล้วคืนค่าตามช่องในฟอร์มค่าใช้จ่าย
//  เรียกจากแอป: sb.functions.invoke('receipt-read', { body: { image, categories, payMethods } })
//    image       = data URL รูป (jpeg/png/webp) ที่ย่อแล้วฝั่งแอป
//    categories  = รายการหมวดหมู่ใน select#reno-cat (AI ต้องเลือกจากนี้เท่านั้น)
//    payMethods  = รายการวิธีชำระใน select#reno-pay
//
//  เลือก AI จาก Secret ที่ตั้งไว้ (Supabase Dashboard › Edge Functions › Secrets):
//    GEMINI_API_KEY    → Google Gemini (มีโควตาฟรี · รุ่นเปลี่ยนได้ด้วย GEMINI_MODEL)
//    ANTHROPIC_API_KEY → Claude
//    ตั้งไว้ทั้งคู่ → ใช้ Gemini ก่อน (บังคับเลือกได้ด้วย RECEIPT_AI = gemini | claude)
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

    const provider = pickProvider();
    if (!provider) {
      return json({ ok: false, code: "no_key", error: "ยังไม่ได้ตั้ง GEMINI_API_KEY หรือ ANTHROPIC_API_KEY ใน Supabase › Edge Functions › Secrets" });
    }

    const { image, categories, payMethods } = await req.json();
    const m = /^data:(image\/[a-z]+);base64,(.+)$/.exec(String(image || ""));
    if (!m || !MEDIA_TYPES.includes(m[1] as MediaType)) return json({ ok: false, error: "รูปไม่ถูกต้อง (ต้องเป็น jpeg/png/webp)" }, 400);
    if (m[2].length > 7_000_000) return json({ ok: false, error: "รูปใหญ่เกินไป" }, 400);
    const cats = (Array.isArray(categories) ? categories : []).map(String).filter(Boolean).slice(0, 60);
    const pays = (Array.isArray(payMethods) ? payMethods : []).map(String).filter(Boolean).slice(0, 20);
    if (!cats.length) return json({ ok: false, error: "ไม่มีรายการหมวดหมู่" }, 400);

    const input: ReadInput = {
      mediaType: m[1] as MediaType,
      base64: m[2],
      schema: receiptSchema(cats, pays),
      prompt: `หมวดหมู่ที่เลือกได้: ${cats.join(" | ")}\nวิธีชำระที่เลือกได้: ${pays.join(" | ")}\n\nอ่านบิลนี้แล้วกรอกข้อมูล`,
    };
    const out = provider === "gemini" ? await readWithGemini(input) : await readWithClaude(input);
    return json({ ...out, provider });
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) return json({ ok: false, code: "bad_key", error: "ANTHROPIC_API_KEY ไม่ถูกต้อง" });
    if (e instanceof Anthropic.RateLimitError) return json({ ok: false, error: "AI ถูกเรียกถี่เกินไป รอสักครู่แล้วลองใหม่" });
    if (e instanceof Anthropic.APIError) return json({ ok: false, error: `AI error ${e.status}: ${e.message}` }, 502);
    return json({ ok: false, error: String(e) }, 500);
  }
});

// ── เลือก AI ตาม Secret ที่ตั้งไว้ ─────────────────────────────
function pickProvider(): "gemini" | "claude" | null {
  const forced = (Deno.env.get("RECEIPT_AI") || "").toLowerCase();
  const hasGemini = !!Deno.env.get("GEMINI_API_KEY");
  const hasClaude = !!Deno.env.get("ANTHROPIC_API_KEY");
  if (forced === "claude" && hasClaude) return "claude";
  if (forced === "gemini" && hasGemini) return "gemini";
  return hasGemini ? "gemini" : hasClaude ? "claude" : null;
}

type ReadInput = { mediaType: MediaType; base64: string; schema: Record<string, unknown>; prompt: string };
type ReadOutput = { ok: true; data: unknown } | { ok: false; code?: string; error: string };

function receiptSchema(cats: string[], pays: string[]) {
  return {
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
}

// ── Claude (Anthropic SDK) ────────────────────────────────────
async function readWithClaude(inp: ReadInput): Promise<ReadOutput> {
  const client = new Anthropic();
  const res = await client.beta.messages.create({
    model: "claude-opus-5-5",
    max_tokens: 4000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "low", format: { type: "json_schema", schema: inp.schema } },
    system: SYSTEM,
    messages: [{
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: inp.mediaType, data: inp.base64 } },
        { type: "text", text: inp.prompt },
      ],
    }],
  });
  if (res.stop_reason === "refusal") return { ok: false, error: "AI ปฏิเสธการอ่านรูปนี้" };
  if (res.stop_reason === "max_tokens") return { ok: false, error: "AI ตอบไม่จบ ลองใหม่อีกครั้ง" };
  const text = res.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("");
  return { ok: true, data: JSON.parse(text) };
}

// ── Gemini (REST generateContent + responseJsonSchema) ────────
// โควตาฟรีเจอ 503 "high demand" บ่อย → ลองซ้ำ 1 ครั้ง แล้วสลับไปรุ่นสำรอง
const GEMINI_FALLBACK_MODELS = ["gemini-3.6-flash", "gemini-3.5-flash"];
async function readWithGemini(inp: ReadInput): Promise<ReadOutput> {
  const primary = Deno.env.get("GEMINI_MODEL") || "gemini-3.8-flash";
  const attempts = [primary, primary, ...GEMINI_FALLBACK_MODELS.filter((m) => m !== primary)];
  let res!: Response;
  let body: any = {};
  for (const [i, model] of attempts.entries()) {
    if (i > 0) await new Promise((r) => setTimeout(r, 1200));
    res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": Deno.env.get("GEMINI_API_KEY")! },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM }] },
        contents: [{
          role: "user",
          parts: [
            { inline_data: { mime_type: inp.mediaType, data: inp.base64 } },
            { text: inp.prompt },
          ],
        }],
        generationConfig: { responseMimeType: "application/json", responseJsonSchema: inp.schema, temperature: 0 },
      }),
    });
    body = await res.json().catch(() => ({}));
    if (res.status !== 503 && res.status !== 500) break;   // ไม่ใช่ปัญหาเซิร์ฟเวอร์ล้น → ไม่ต้องลองต่อ
    console.log("gemini busy", model, res.status);
  }
  if (!res.ok) {
    const msg = body?.error?.message || `HTTP ${res.status}`;
    if (res.status === 400 && /API key/i.test(msg)) return { ok: false, code: "bad_key", error: "GEMINI_API_KEY ไม่ถูกต้อง" };
    if (res.status === 403) return { ok: false, code: "bad_key", error: "GEMINI_API_KEY ใช้ไม่ได้ (ไม่มีสิทธิ์)" };
    if (res.status === 429) return { ok: false, error: "ใช้โควตา Gemini ครบแล้ว รอสักครู่ (หรือพรุ่งนี้) แล้วลองใหม่" };
    if (res.status === 503) return { ok: false, error: "Gemini มีคนใช้เยอะชั่วคราว ลองถ่าย/เลือกรูปใหม่อีกสักครู่" };
    return { ok: false, error: `Gemini error ${res.status}: ${msg}` };
  }
  const cand = body?.candidates?.[0];
  const text = (cand?.content?.parts || []).map((p: { text?: string }) => p.text || "").join("");
  if (!text) {
    const why = cand?.finishReason || body?.promptFeedback?.blockReason || "ไม่มีคำตอบ";
    return { ok: false, error: `Gemini อ่านรูปนี้ไม่ได้ (${why})` };
  }
  return { ok: true, data: JSON.parse(text) };
}
