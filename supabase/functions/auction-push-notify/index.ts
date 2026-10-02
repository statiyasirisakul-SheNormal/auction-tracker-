// ══════════════════════════════════════════════════════════════
//  Edge Function: auction-push-notify — แจ้งเตือนผ่านเครื่อง (Web Push) แยก 2 แบบ
//    1) ทุกนัดทุกทรัพย์ (auction_settings.push_all)      → ทันทีที่เปลี่ยนเป็นวันประมูล (00:01)
//    2) นัดที่เข้าซื้อ 🎯 (auction_settings.push_target) → ล่วงหน้า 5 วัน (ข้อความเตรียมตัว)
//  สวิตช์ทั้งสองตั้งในแอป (⚙️ › แจ้งเตือน) ค่าเริ่มต้น = เปิด
//  รันวันละครั้ง 00:01 เวลาไทย (= 17:01 UTC ของวันก่อน) ด้วย pg_cron (ดู supabase/push.sql)
//
//  เรียกได้ 2 แบบ (verify_jwt ปิด — ตรวจสิทธิ์เองข้างล่าง):
//    { action:"run" }  + header x-cron-secret     → ส่งเตือนนัดที่ถึงกำหนดวันนี้ (cron)
//    { action:"run" }  + Bearer JWT ที่ล็อกอินแล้ว → เหมือนกัน (กด "ส่งเตือนตอนนี้" จากแอป)
//    { action:"test", endpoint? } + Bearer JWT    → ส่งข้อความทดสอบ (ทุกเครื่อง หรือเฉพาะ endpoint)
//
//  ค่าลับอยู่ในตาราง push_config (RLS ไม่มี policy → อ่านได้เฉพาะ service role)
//  เข้ารหัส Web Push เอง (RFC 8291 aes128gcm + VAPID RFC 8292) ด้วย WebCrypto ล้วน ไม่พึ่งไลบรารี
// ══════════════════════════════════════════════════════════════
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ALL_OFFSETS = [0];                              // ทุกนัด: วันประมูล (ส่งตอน 00:01)
const TARGET_DAYS = 5;                                // นัดที่เข้าซื้อ: ล่วงหน้า 5 วัน
const ROUND_DISC = [0, 0.10, 0.20, 0.30, 0.30, 0.30]; // ตรงกับ ROUNDS ใน index.html
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// ── utils ─────────────────────────────────────────────────────
const enc = new TextEncoder();
function b64uDecode(s: string): Uint8Array {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}
function b64uEncode(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, len: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, len * 8));
}
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

// วันนี้ตามเวลาไทยเป็น YYYY-MM-DD
function todayBangkok(): string {
  return new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
}
function daysBetween(fromISO: string, toISO: string): number {
  return Math.round((Date.parse(toISO + "T00:00:00Z") - Date.parse(fromISO + "T00:00:00Z")) / 86400000);
}
function fmtTH(iso: string): string {
  const [y, m, d] = iso.split("-");
  const months = ["ม.ค.","ก.พ.","มี.ค.","เม.ย.","พ.ค.","มิ.ย.","ก.ค.","ส.ค.","ก.ย.","ต.ค.","พ.ย.","ธ.ค."];
  return `${+d} ${months[+m - 1]} ${+y + 543}`;
}
const money = (n: number) => (Number(n) || 0).toLocaleString("en-US");
// ตรงกับ isHaltedNote ใน index.html
function isHaltedNote(note: unknown): boolean {
  return /งดขาย|งดการขาย|งดบังคับคดี|งดการบังคับคดี|ถอนการยึด|ถอนการบังคับคดี/.test(String(note || "").replace(/\s+/g, ""));
}

// ── VAPID (RFC 8292) ──────────────────────────────────────────
type Vapid = { key: CryptoKey; pub: string; subject: string };
async function loadVapid(cfg: Record<string, string>): Promise<Vapid> {
  const jwk = JSON.parse(cfg.vapid_private_jwk);
  const key = await crypto.subtle.importKey("jwk", { ...jwk, ext: true }, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const pub = b64uEncode(concat(new Uint8Array([4]), b64uDecode(jwk.x), b64uDecode(jwk.y)));
  return { key, pub, subject: cfg.vapid_subject || "mailto:owner@auction.local" };
}
async function vapidAuth(v: Vapid, endpoint: string): Promise<string> {
  const aud = new URL(endpoint).origin;
  const header = b64uEncode(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64uEncode(enc.encode(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: v.subject })));
  const unsigned = `${header}.${claims}`;
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, v.key, enc.encode(unsigned)));
  return `vapid t=${unsigned}.${b64uEncode(sig)}, k=${v.pub}`;
}

// ── เข้ารหัส payload (RFC 8291, aes128gcm) ─────────────────────
async function encryptPayload(p256dh: string, authSecret: string, plaintext: Uint8Array): Promise<Uint8Array> {
  const uaPublic = b64uDecode(p256dh);
  const auth = b64uDecode(authSecret);
  const as = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", as.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, as.privateKey, 256));

  const ikm = await hkdf(auth, shared, concat(enc.encode("WebPush: info\0"), uaPublic, asPublic), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);

  const aesKey = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const padded = concat(plaintext, new Uint8Array([2]));   // 0x02 = record สุดท้าย
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aesKey, padded));

  const rs = new Uint8Array(4); new DataView(rs.buffer).setUint32(0, 4096);
  return concat(salt, rs, new Uint8Array([asPublic.length]), asPublic, cipher);
}

type Sub = { endpoint: string; p256dh: string; auth: string };
async function sendPush(v: Vapid, sub: Sub, payload: unknown): Promise<number> {
  const body = await encryptPayload(sub.p256dh, sub.auth, enc.encode(JSON.stringify(payload)));
  const res = await fetch(sub.endpoint, {
    method: "POST",
    headers: {
      "Authorization": await vapidAuth(v, sub.endpoint),
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      "TTL": "86400",
      "Urgency": "high",
    },
    body,
  });
  // เก็บเหตุผลที่ push service ตอบกลับไว้ใน log (เช่น Apple: BadJwtToken / BadDeviceToken)
  if (res.ok) await res.body?.cancel();
  else console.log("push status", res.status, new URL(sub.endpoint).host, (await res.text()).slice(0, 200));
  return res.status;
}

// ── หานัดที่ต้องเตือนวันนี้ ────────────────────────────────────
type Due = { key: string; payload: Record<string, unknown> };
type Prefs = { all: boolean; target: boolean };
function dueReminders(rows: { id: string; data: any }[], today: string, prefs: Prefs): Due[] {
  const out: Due[] = [];
  for (const row of rows) {
    const p = row.data || {};
    if (p.pool) continue;                                   // ทรัพย์รอสำรวจ ยังไม่ได้เก็บ
    if (p.notify === false) continue;                       // ปิดเตือนรายทรัพย์
    if (p.status === "lost" || p.status === "sold") continue;
    const base = Number(p.appraisal) || Number(p.price) || 0;
    const name = [p.code, p.name].filter(Boolean).join(" ") || "(ไม่มีชื่อ)";
    (p.rounds || []).forEach((r: any, ri: number) => {
      const date = r && typeof r === "object" ? r.date : "";
      if (!date || isHaltedNote(r.note)) return;
      const diff = daysBetween(today, date);
      const isTarget = ri === (p.targetRound || 0);
      const bid = base ? Math.floor(base * (1 - (ROUND_DISC[ri] || 0))) : 0;
      const priceLine = `🗓 ${fmtTH(date)}${bid ? ` · 💰 ${money(bid)} ฿` : ""}`;
      const payload = (title: string, lines: string[]) => ({
        title, body: lines.filter(Boolean).join("\n"),
        tag: `auction-${row.id}-${ri}`, propId: row.id, url: `./index.html#prop=${row.id}`,
      });

      // 2) นัดที่เข้าซื้อ — ล่วงหน้า 5 วัน ให้มีเวลาเตรียมเงิน/เอกสาร
      if (prefs.target && isTarget && diff === TARGET_DAYS) {
        out.push({
          key: `${row.id}:${ri}:${date}:target${TARGET_DAYS}d`,
          payload: payload(`🎯 อีก ${TARGET_DAYS} วัน ประมูลนัดที่เข้าซื้อ (นัดที่ ${ri + 1})`, [
            name, priceLine, "เตรียมเงินวางหลักประกัน + ใบมอบอำนาจ/เอกสารให้พร้อม", p.loc ? `📍 ${p.loc}` : "",
          ]),
        });
      }
      // 1) ทุกนัดทุกทรัพย์ — แจ้งทันทีที่เปลี่ยนเป็นวันประมูล
      if (prefs.all && ALL_OFFSETS.includes(diff)) {
        out.push({
          key: `${row.id}:${ri}:${date}:${diff}d`,
          payload: payload(`🔴 วันนี้ประมูล · นัดที่ ${ri + 1}${isTarget ? " 🎯 นัดที่เข้าซื้อ" : ""}`, [
            name, priceLine, p.loc ? `📍 ${p.loc}` : "",
          ]),
        });
      }
    });
  }
  return out;
}

// ── main ──────────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data: cfgRows, error: cfgErr } = await sb.from("push_config").select("key,value");
    if (cfgErr) throw cfgErr;
    const cfg = Object.fromEntries((cfgRows ?? []).map((r) => [r.key, r.value]));

    // ตรวจสิทธิ์: cron secret หรือ JWT ของคนที่ล็อกอินด้วย PIN แล้ว
    const body = await req.json().catch(() => ({}));
    const cronOk = !!cfg.cron_secret && req.headers.get("x-cron-secret") === cfg.cron_secret;
    let userOk = false;
    if (!cronOk) {
      const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
      if (jwt) { const { data } = await sb.auth.getUser(jwt); userOk = !!data?.user; }
    }
    if (!cronOk && !userOk) return json({ ok: false, error: "unauthorized" }, 401);

    const vapid = await loadVapid(cfg);
    let subQ = sb.from("push_subscriptions").select("endpoint,p256dh,auth");
    if (body.action === "test" && body.endpoint) subQ = subQ.eq("endpoint", body.endpoint);
    const { data: subs, error: subErr } = await subQ;
    if (subErr) throw subErr;
    if (!subs?.length) return json({ ok: true, sent: 0, note: "ยังไม่มีเครื่องที่เปิดแจ้งเตือน" });

    // ส่งไปทุกเครื่อง · เครื่องที่ยกเลิกไปแล้ว (404/410) ลบทิ้ง
    const dead = new Set<string>();
    const okAt = new Set<string>();
    const fanout = async (payload: unknown) => {
      await Promise.all(subs.map(async (s) => {
        if (dead.has(s.endpoint)) return;
        try {
          const st = await sendPush(vapid, s, payload);
          if (st === 404 || st === 410) dead.add(s.endpoint);
          else if (st >= 200 && st < 300) okAt.add(s.endpoint);
        } catch (e) { console.log("push error", String(e)); }
      }));
    };

    let sent = 0;
    const results: string[] = [];
    if (body.action === "test") {
      await fanout({ title: "🔔 ทดสอบแจ้งเตือน", body: "เครื่องนี้พร้อมรับแจ้งเตือนวันนัดประมูลแล้ว", tag: "auction-test", url: "./index.html" });
      sent = okAt.size;
    } else {
      const today = todayBangkok();
      const { data: rows, error } = await sb.from("auction_props").select("id,data");
      if (error) throw error;
      const { data: setRows } = await sb.from("auction_settings").select("key,value").in("key", ["push_all", "push_target"]);
      const set = Object.fromEntries((setRows ?? []).map((r) => [r.key, r.value]));
      const prefs: Prefs = { all: set.push_all !== "0", target: set.push_target !== "0" };
      for (const d of dueReminders(rows ?? [], today, prefs)) {
        const { data: already } = await sb.from("push_sent").select("key").eq("key", d.key).maybeSingle();
        if (already) continue;
        await fanout(d.payload);
        await sb.from("push_sent").insert({ key: d.key });
        sent++; results.push(d.key);
      }
    }

    if (dead.size) await sb.from("push_subscriptions").delete().in("endpoint", [...dead]);
    if (okAt.size) await sb.from("push_subscriptions").update({ last_ok_at: new Date().toISOString() }).in("endpoint", [...okAt]);
    return json({ ok: true, sent, devices: subs.length, delivered: okAt.size, removed: dead.size, results });
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
});
