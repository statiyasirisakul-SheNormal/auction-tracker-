"""สร้าง dist/ สำหรับขึ้น Cloudflare — เฉพาะไฟล์ที่เว็บต้องใช้ (ไม่เอา supabase/, *.sql, ไฟล์กู้ข้อมูล ขึ้นเว็บ)
ใช้: python build_dist.py แล้ว npx wrangler deploy"""
import os, shutil, sys
if hasattr(sys.stdout, "reconfigure"): sys.stdout.reconfigure(encoding="utf-8")
here = os.path.dirname(os.path.abspath(__file__))
dist = os.path.join(here, "dist")
shutil.rmtree(dist, ignore_errors=True)
os.makedirs(dist)
for f in ["index.html", "sw.js", "manifest.webmanifest", "landsmaps-bookmarklet.js",
          "icon.svg", "icon-192.png", "icon-512.png", "apple-touch-icon.png"]:
    shutil.copy(os.path.join(here, f), os.path.join(dist, f))
# หน้าเว็บ/sw/ปุ่มลัด ห้าม cache นาน จะได้เห็นเวอร์ชันใหม่ทันทีหลัง deploy · กันฝังในเว็บอื่น
with open(os.path.join(dist, "_headers"), "w", encoding="utf-8") as f:
    f.write("/*\n  X-Frame-Options: DENY\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: strict-origin-when-cross-origin\n"
            "/\n  Cache-Control: no-cache\n/index.html\n  Cache-Control: no-cache\n/sw.js\n  Cache-Control: no-cache\n"
            "/landsmaps-bookmarklet.js\n  Cache-Control: no-cache\n"
            "/manifest.webmanifest\n  Content-Type: application/manifest+json\n")
print("dist/ พร้อม:", sorted(os.listdir(dist)))
