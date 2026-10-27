# สคริปต์ตรวจสอบและทดลอง

รวมไฟล์ `.cjs` สำหรับทดสอบ provider และ SQL แยกจากโค้ด runtime
ไฟล์เหล่านี้ไม่ทำงานเองตอน `npm run dev` และไม่ได้เป็น API endpoint
ให้รันคำสั่งจากโฟลเดอร์หลักของ backend เพื่อให้ `.env` และ path ของ `tmp` ตรงกัน

```bash
# Yahoo SET/SET50: ไม่ใช้ .env หรือ API key
node --use-system-ca scripts/verification/verify-yahoo-index-history.cjs

# ทดสอบ yahoo-finance2 ซึ่งติดตั้งแยกไว้ใน tmp
node --use-system-ca scripts/verification/verify-yahoo-finance2.cjs
node --use-system-ca scripts/verification/verify-yahoo-finance2.cjs --thai-dates

# ทดสอบ Analytics ด้วยพอร์ตสมมติและ provider จริง
node --use-system-ca --env-file=.env scripts/verification/verify-analytics.cjs

# ทดสอบ SQL ในหน่วยความจำ ไม่เข้าฐานข้อมูลจริง
node scripts/verification/verify-investment-sql.cjs tmp/cost-basis-validation
```

`verify-yahoo-finance2.cjs` ต้องมีแพ็กเกจทดสอบติดตั้งไว้ก่อน:

```bash
npm install --prefix tmp/yahoo-finance2-validation --no-save --package-lock=false --ignore-scripts yahoo-finance2@4.0.5
```

SQL verifier ใช้ PGlite ที่ติดตั้งแยกใน `tmp/cost-basis-validation` ดูคำสั่งติดตั้งต้นไฟล์
Analytics verifier ตอนนี้ใช้ TradingView v4 สำหรับ SET/SET50 history จริงด้วย
ตรวจทั้ง HTTP requests และ TradingView loads ว่าเรียกซ้ำ/เปลี่ยนหมวดหลัง ALL ไม่เพิ่มคำขอ
สคริปต์ verify-tradingview-history.cjs ยังคงเป็นการทดลอง Client/Session.Chart v3 ใน tmp แยกจาก runtime v4
`node --use-system-ca scripts/verification/verify-thai-index-history.cjs` ตรวจ runtime v4 จริงย้อนหลังหนึ่งปี
และ cache ช่วงสั้น → ALL เทียบ cold ALL โดยไม่ใช้ env หรือฐานข้อมูล
ส่วนสคริปต์ Finnhub, SEC, Frankfurter และโลโก้ ใช้ key/provider settings เดิมจาก `.env` ตามที่เกี่ยวข้อง
คำสั่ง provider ใช้เครือข่ายและอาจใช้ quota จริง; ไม่ได้รันทั้งหมดอัตโนมัติเมื่อทดสอบ SQL
