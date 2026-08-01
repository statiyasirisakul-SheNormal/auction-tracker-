// ══════════════════════════════════════════════════════════════
//  Edge Function: auction-line-notify (item 6)
//  แจ้งเตือน LINE ก่อนวันนัดประมูล 3 วัน — ยิงเข้ากลุ่ม LINE ของ user
//  รันวันละครั้งด้วย pg_cron (ดู notify-cron.sql)
//
//  Secrets ที่ต้องตั้ง (supabase secrets set ...):
//    SB_URL                     = https://rjpzmaeiopiqtsjaksed.supabase.co
//    SB_SERVICE_ROLE            = <service_role key ของโปรเจกต์>
//    LINE_CHANNEL_ACCESS_TOKEN  = <LINE Messaging API channel token>
//    LINE_TARGET_ID             = <groupId/userId ปลายทาง>
//    NOTIFY_DAYS_BEFORE         = 3   (ไม่บังคับ, ค่าเริ่มต้น 3)
// ══════════════════════════════════════════════════════════════
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ROUND_DISC = [0, 0.10, 0.20, 0.30, 0.30, 0.30];

// วันนี้ตามเวลาไทย (Asia/Bangkok) เป็น YYYY-MM-DD
function todayBangkok(): string {
  const now = new Date(Date.now() + 7 * 3600 * 1000);
  return now.toISOString().slice(0, 10);
}
function daysBetween(fromISO: string, toISO: string): number {
  return Math.round(
    (new Date(toISO + "T00:00:00Z").getTime() - new Date(fromISO + "T00:00:00Z").getTime()) / 86400000,
  );
}
function fmtTH(iso: string): string {
  const [y, m, d] = iso.split("-");
  const months = ["ม.ค.","ก.พ.","มี.ค.","เม.ย.","พ.ค.","มิ.ย.","ก.ค.","ส.ค.","ก.ย.","ต.ค.","พ.ย.","ธ.ค."];
  return `${+d} ${months[+m - 1]} ${+y + 543}`;
}
function money(n: number): string {
  return (Number(n) || 0).toLocaleString("en-US");
}

async function sendLine(token: string, to: string, text: string) {
  const res = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
    body: JSON.stringify({ to, messages: [{ type: "text", text }] }),
  });
  if (!res.ok) throw new Error(`LINE ${res.status}: ${await res.text()}`);
}

Deno.serve(async (_req) => {
  try {
    const SB_URL = Deno.env.get("SB_URL")!;
    const SB_KEY = Deno.env.get("SB_SERVICE_ROLE")!;
    const LINE_TOKEN = Deno.env.get("LINE_CHANNEL_ACCESS_TOKEN")!;
    const LINE_TARGET = Deno.env.get("LINE_TARGET_ID")!;
    const DAYS = parseInt(Deno.env.get("NOTIFY_DAYS_BEFORE") || "3");

    if (!SB_URL || !SB_KEY || !LINE_TOKEN || !LINE_TARGET) {
      return new Response("missing secrets", { status: 500 });
    }
    const sb = createClient(SB_URL, SB_KEY);
    const today = todayBangkok();

    const { data: rows, error } = await sb.from("auction_props").select("id,user_key,data");
    if (error) throw error;

    let sent = 0;
    const results: string[] = [];

    for (const row of rows ?? []) {
      const p = row.data || {};
      if (p.lineNotify === false) continue;                 // ปิดเตือนไว้
      if (p.status === "lost" || p.status === "sold") continue;
      const ti = p.targetRound || 0;
      const round = (p.rounds || [])[ti];
      const rDate = round && typeof round === "object" ? round.date : "";
      if (!rDate) continue;

      const diff = daysBetween(today, rDate);
      if (diff !== DAYS) continue;                          // เตือนเฉพาะเมื่อเหลือ N วันพอดี

      // กันส่งซ้ำ
      const key = `${row.id}:${rDate}:${DAYS}d`;
      const { data: already } = await sb.from("auction_line_sent").select("key").eq("key", key).maybeSingle();
      if (already) continue;

      const base = Number(p.appraisal) || Number(p.price) || 0;
      const bid = base ? Math.floor(base * (1 - (ROUND_DISC[ti] || 0))) : 0;
      const text =
        `🏛️ เตือนประมูลทรัพย์ (อีก ${DAYS} วัน)\n` +
        `📌 ${[p.code, p.name].filter(Boolean).join(" — ") || "(ไม่มีชื่อ)"}\n` +
        (p.loc ? `📍 ${p.loc}\n` : "") +
        `🗓 นัดที่ ${ti + 1}: ${fmtTH(rDate)}\n` +
        (bid ? `💰 ราคาเป้าประมูล: ${money(bid)} ฿\n` : "") +
        (p.case ? `⚖️ คดี ${p.case}` : "");

      await sendLine(LINE_TOKEN, LINE_TARGET, text);
      await sb.from("auction_line_sent").insert({ key, sent_at: new Date().toISOString() });
      sent++;
      results.push(key);
    }

    return new Response(JSON.stringify({ ok: true, today, sent, results }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e) }), { status: 500 });
  }
});
