// ═══ ปุ่มลัด LandsMaps → Auction Tracker ═══
// โหลดผ่าน bookmarklet บนหน้า landsmaps.dol.go.th (ผู้ใช้ล็อกอินเอง แล้วกดเอง)
// อ่านพิกัด/เนื้อที่/ราคาประเมินจากหน้าต่างข้อมูลแปลงที่โชว์อยู่ → ถ่ายภาพแท็บ (ผู้ใช้กดอนุญาต) → ส่งให้แอป
// ไม่เรียก API ของกรมที่ดินเอง ใช้แค่สิ่งที่หน้าเว็บแสดงให้ผู้ใช้เห็นอยู่แล้ว
(function () {
  'use strict';
  if (location.hostname !== 'landsmaps.dol.go.th') {
    alert('ปุ่มนี้ใช้บนหน้า landsmaps.dol.go.th เท่านั้น');
    return;
  }
  if (window.__acktionLM) { window.__acktionLM.open(); return; }

  const SRC = (document.currentScript && document.currentScript.src) || '';
  const APP_URL = SRC ? new URL('./', SRC).href : 'https://auction-tracker.s-tatiyasirisakul.workers.dev/';
  const APP_ORIGIN = new URL(APP_URL).origin;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const findBtn = t => [...document.querySelectorAll('button')].find(b => b.offsetParent && b.textContent.includes(t));

  // ── อ่านข้อมูลแปลงจากหน้าต่างข้อมูลที่โชว์อยู่ ──
  function readParcel() {
    const txt = document.body.innerText || '';
    const llRe = /(\d{1,2}\.\d{4,})\s*,\s*(\d{2,3}\.\d{4,})/;
    const at = txt.search(/พิกัดแปลง/);
    let m = at >= 0 ? txt.slice(at, at + 200).match(llRe) : null;
    if (!m) m = txt.match(llRe);
    const lat = m ? +m[1] : NaN, lng = m ? +m[2] : NaN;
    if (!(lat > 5 && lat < 21 && lng > 97 && lng < 106)) return null;
    const a = txt.match(/(\d+)\s*ไร่\s*(\d+)\s*งาน\s*([\d.]+)\s*ตาราง\s*วา/);
    const pr = txt.match(/ราคาประเมิน[^\n]{0,40}?([\d,]{3,})\s*บาท/) || txt.match(/ราคาประเมิน[^\d]{0,40}\n?\s*([\d,]{3,})/);
    const token = new URLSearchParams(location.search).get('qrcodeToken') || '';
    let deedKey = '';
    try { deedKey = token ? atob(token) : ''; } catch (e) {}
    return {
      lat, lng,
      area: a ? `${a[1]}-${a[2]}-${a[3]}` : '',
      price: pr ? pr[1] : '',
      token: /^[A-Za-z0-9+/=]+$/.test(token) ? token : '',
      deedKey: /^\d+,\d+,\d+$/.test(deedKey) ? deedKey : ''
    };
  }

  // ── ถ่ายภาพแท็บนี้ (Chrome/Edge บนคอม: กด "แชร์แท็บนี้") ──
  async function captureTab(beforeGrab) {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { displaySurface: 'browser', frameRate: 5 }, audio: false,
      preferCurrentTab: true, selfBrowserSurface: 'include', surfaceSwitching: 'exclude'
    });
    try {
      await beforeGrab();
      const v = document.createElement('video');
      v.muted = true; v.playsInline = true; v.srcObject = stream;
      await v.play();
      await sleep(700);
      const W = v.videoWidth, H = v.videoHeight, sx = W / innerWidth, sy = H / innerHeight;
      // ตัดแถบหัวเว็บออก แล้วครอปรอบกลางแผนที่ (หมุดอยู่กลางจอ)
      const top = Math.max(0, ...[...document.querySelectorAll('header, nav, .navbar')]
        .filter(e => e.offsetParent).map(e => e.getBoundingClientRect().bottom).filter(b => b < 160));
      const cw = Math.min(innerWidth, 900), ch = Math.min(innerHeight - top, 760);
      const cx = innerWidth / 2, cy = top + (innerHeight - top) / 2;
      const x0 = Math.max(0, cx - cw / 2), y0 = Math.max(top, cy - ch / 2);
      const scale = Math.min(1, 900 / (cw * sx));
      const c = document.createElement('canvas');
      c.width = Math.round(cw * sx * scale); c.height = Math.round(ch * sy * scale);
      c.getContext('2d').drawImage(v, x0 * sx, y0 * sy, cw * sx, ch * sy, 0, 0, c.width, c.height);
      return c.toDataURL('image/jpeg', 0.82);
    } finally {
      stream.getTracks().forEach(t => t.stop());
    }
  }

  // ── ส่งให้แอป: แท็บแอปที่เปิด LandsMaps มา (opener) หรือเปิดแอปใหม่ ──
  function sendTo(win, payload) {
    return new Promise(resolve => {
      let done = false;
      const onMsg = e => {
        if (e.origin !== APP_ORIGIN || !e.data) return;
        if (e.data.type === 'acktion-lm-ready' && e.source === win) win.postMessage(payload, APP_ORIGIN);
        if (e.data.type === 'acktion-landsmaps-ok') { done = true; cleanup(); resolve(true); }
      };
      const cleanup = () => removeEventListener('message', onMsg);
      addEventListener('message', onMsg);
      try { win.postMessage(payload, APP_ORIGIN); } catch (e) {}
      setTimeout(() => { if (!done) { cleanup(); resolve(false); } }, 20000);
    });
  }

  // ── แผงควบคุมลอยบน LandsMaps ──
  const box = document.createElement('div');
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-label', 'ส่งแปลงเข้า Auction Tracker');
  box.style.cssText = 'position:fixed;z-index:2147483647;right:12px;bottom:12px;width:min(320px,calc(100vw - 24px));background:#fff;color:#0F172A;border-radius:14px;box-shadow:0 12px 40px rgba(16,24,40,.25);font:14px/1.5 Sarabun,"Segoe UI",sans-serif;padding:14px';
  document.body.appendChild(box);
  let parcel = null, payload = null;

  const btn = (label, primary) => `<button type="button" style="min-height:44px;padding:8px 14px;border-radius:10px;border:1.5px solid ${primary ? '#13305E' : '#CBD5E1'};background:${primary ? '#13305E' : '#fff'};color:${primary ? '#fff' : '#13305E'};font:700 14px inherit;font-family:inherit;cursor:pointer">${label}</button>`;
  function render(html) {
    box.innerHTML = `<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px"><b style="flex:1">📍 ส่งแปลงเข้า Auction Tracker</b><button type="button" data-x aria-label="ปิด" style="border:none;background:none;font-size:20px;cursor:pointer;min-width:40px;min-height:40px">✕</button></div>${html}`;
    box.querySelector('[data-x]').onclick = () => { box.style.display = 'none'; };
  }

  function showStart() {
    parcel = readParcel();
    if (!parcel) {
      render(`<div style="color:#B45309">ยังไม่เห็นข้อมูลแปลง — ค้นโฉนดให้หน้าต่าง "ข้อมูลแปลงที่ดิน" ขึ้นมาก่อน (หรือแตะที่หมุดแปลง) แล้วกดปุ่มนี้อีกครั้ง</div><div style="margin-top:10px">${btn('ลองอ่านใหม่', true)}</div>`);
      box.querySelectorAll('button')[1].onclick = showStart;
      return;
    }
    render(`<div style="background:#F4F6FA;border-radius:10px;padding:8px 10px;margin-bottom:10px">
        พิกัด <b>${parcel.lat.toFixed(6)}, ${parcel.lng.toFixed(6)}</b><br>
        ${parcel.area ? `เนื้อที่ <b>${parcel.area}</b> ไร่-งาน-วา<br>` : ''}
        ${parcel.price ? `ราคาประเมิน <b>${parcel.price}</b> ฿/ตร.ว.` : ''}
      </div>
      <div style="font-size:13px;color:#5A6577;margin-bottom:10px">กดปุ่มด้านล่าง → เลือก <b>"แท็บนี้"</b> แล้วกดแชร์ เพื่อถ่ายภาพแผนที่แปลง (ภาพจะถูกถ่ายครั้งเดียวแล้วหยุดแชร์ทันที)</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">${btn('📸 ถ่ายภาพ + ส่ง', true)}${btn('ส่งแค่พิกัด')}</div>`);
    const [, shot, noShot] = box.querySelectorAll('button');
    shot.onclick = () => go(true);
    noShot.onclick = () => go(false);
  }

  async function go(withImg) {
    let img = '';
    if (withImg) {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
        render('<div style="color:#B91C1C">เบราว์เซอร์นี้ถ่ายภาพแท็บไม่ได้ — ใช้ Chrome หรือ Edge บนคอม หรือกด "ส่งแค่พิกัด"</div>');
        return;
      }
      try {
        img = await captureTab(async () => {
          box.style.display = 'none';
          const close = findBtn('ปิดหน้าต่าง');
          if (close) close.click();
          await sleep(1500);
        });
      } catch (e) {
        box.style.display = '';
        render(`<div style="color:#B91C1C">ถ่ายภาพไม่สำเร็จ (${e && e.name === 'NotAllowedError' ? 'ไม่ได้กดอนุญาตแชร์แท็บ' : 'เบราว์เซอร์ไม่รองรับ'})</div><div style="margin-top:10px">${btn('ลองใหม่', true)}</div>`);
        box.querySelectorAll('button')[1].onclick = showStart;
        return;
      }
      box.style.display = '';
    }
    payload = { type: 'acktion-landsmaps', v: 1, lat: parcel.lat, lng: parcel.lng, area: parcel.area, price: parcel.price, token: parcel.token, deedKey: parcel.deedKey, img };
    render('<div>⏳ กำลังส่งเข้าแอป...</div>');
    const op = window.opener && !window.opener.closed ? window.opener : null;
    if (op && await sendTo(op, payload)) return sent();
    render(`<div style="margin-bottom:10px">ไม่พบแท็บแอปที่เปิดหน้านี้มา — กดปุ่มเพื่อเปิดแอปแล้วส่งข้อมูลไป</div>${btn('เปิด Auction Tracker แล้วส่ง', true)}`);
    box.querySelectorAll('button')[1].onclick = async () => {
      const w = window.open(APP_URL + '#lm-import', '_blank');
      if (!w) { render('<div style="color:#B91C1C">เบราว์เซอร์บล็อกหน้าต่างใหม่ — อนุญาต pop-up ให้ landsmaps.dol.go.th แล้วลองอีกครั้ง</div>'); return; }
      render('<div>⏳ รอแอปเปิดและล็อกอิน...</div>');
      if (await sendTo(w, payload)) sent();
      else render('<div style="color:#B91C1C">แอปไม่ตอบกลับ — ตรวจว่าล็อกอินแอปแล้ว แล้วลองกดปุ่มลัดอีกครั้ง</div>');
    };
  }

  function sent() {
    render('<div style="color:#15803D;font-weight:700">✓ ส่งแล้ว — ไปเลือกทรัพย์และกดบันทึกในแอป</div>');
  }

  window.__acktionLM = { open() { box.style.display = ''; showStart(); } };
  showStart();
})();
