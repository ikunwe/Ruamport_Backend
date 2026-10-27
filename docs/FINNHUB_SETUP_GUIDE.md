# Finnhub: ตั้งค่าราคา โลโก้ และข่าวหุ้นนอก

Backend ใช้ Finnhub สำหรับราคา โลโก้ และข่าวหุ้นนอก ไม่ต้องเพิ่ม SQL, ลบข้อมูล หรือ import PDF ใหม่ ต้นทุนและยอดจาก PDF ยังเหมือนเดิม Frankfurter ยังเป็นแหล่งเรท USD/THB

## ตั้งค่าครั้งแรก

### การโหลดหลัง restart และการตรวจสอบ

Cache เป็น RAM ใน process จึงว่างหลัง restart รายชื่อหุ้น US ใช้ timeout รวม 20 วินาที ครอบคลุม API redirect ที่อนุญาตและการอ่าน JSON ส่วนราคา/โลโก้/ข่าวแต่ละคำขอยังคง 5 วินาที ไม่เพิ่ม quota หรือเปลี่ยน TTL ราคาหุ้น รายชื่อยัง cache 24 ชั่วโมงตามเดิมและจำกัด redirect host/path ไม่ส่ง API key ต่อไป static host

หากรายชื่อ timeout จะส่ง PRICE_CATALOG_TIMEOUT / LOGO_CATALOG_TIMEOUT พร้อม retryAt แทนการซ่อนเป็น NOT_AVAILABLE ทั่วไป ผลล้มเหลวนี้ใช้ร่วมกันในช่วงรอลองใหม่เพื่อไม่ยิงซ้ำทุกหุ้น ไม่ได้ retry อัตโนมัติเมื่อครบเวลา ต้องมีคำขอใหม่เข้ามา Frontend ควรแสดงราคาข้อมูลไม่พร้อม ไม่แทน null ด้วย 0 และไม่วนเรียกซ้ำทันที

คำขอ holdings ยังรอส่วนที่ขอให้เสร็จก่อนตอบ และเรียกราคา/โลโก้ทีละตัว การโหลดครั้งแรกอาจเป็นหลักสิบวินาที ให้ตรวจ timeout ของ Frontend/proxy ตามงานจริง สามารถขอ holdings โดยไม่ใส่ includeMarket/includeLogos ก่อน แล้วค่อยโหลดข้อมูลตลาด/โลโก้ภายหลังได้ การเพิ่ม budget รายชื่อไม่ได้รับประกันว่า Finnhub จะตอบสำเร็จทุกครั้ง

ตรวจสดแบบอ่านอย่างเดียว ไม่แตะ Database และไม่พิมพ์ API key/signed URL:

```sh
node --use-system-ca --env-file=.env scripts/verification/verify-finnhub.cjs
```

สคริปต์ใช้ cold cache ใหม่ ตรวจรายชื่อ ราคาและ URL โลโก้ 7 ตัว แล้วเรียกซ้ำเพื่อวัดจำนวนคำขอ cache แต่ละครั้งที่รันใหม่ใช้ quota จริง จึงไม่ควรรันถี่ ใช้เวลา headersAfterMs เป็นเวลาได้รับ headers เท่านั้น ไม่ใช่เวลาโหลด body จบ ภาพจริงยังโหลดโดย browser ตามเดิม

1. สมัคร/เข้าสู่ระบบ [Finnhub Dashboard](https://finnhub.io/dashboard) แล้วคัดลอก API key ของบัญชี
2. ใส่ key ในไฟล์ Backend .env ตรง FINNHUB_API_KEY ที่เพิ่มไว้แล้ว อย่าส่ง key มาทางแชตหรือใส่ใน Frontend
3. ใช้ค่าตั้งต้นนี้ โดยไม่ต้องสร้าง key ใหม่ใน Supabase:

~~~env
FINNHUB_API_KEY=your_finnhub_key
FINNHUB_CALLS_PER_MINUTE=60
FINNHUB_CALLS_PER_DAY=0
STOCK_PRICE_CACHE_TTL_SECONDS=900
STOCK_LOGO_CACHE_TTL_SECONDS=604800
STOCK_NEWS_CACHE_TTL_SECONDS=1800
~~~

4. หยุด process เดิม แล้วรัน npm run dev ใหม่
5. Login เว็บให้ได้ Supabase access token แล้วลอง endpoints ด้านล่าง

ใช้ FINNHUB_API_KEY ของ Finnhub เท่านั้น Backend ไม่มี fallback ไปผู้ให้บริการรายอื่น

## ลองใช้งาน

ส่ง Authorization: Bearer <Supabase access_token> ให้ทุก endpoint:

~~~http
GET /api/v1/trades/holdings?includeMarket=true&includeLogos=true&includeFx=true
GET /api/v1/trades/stocks/AMD/news?exchange=XNAS&limit=20
~~~

ต้องมีหุ้นนอก USD ของตัวเองที่ import แล้วและ quantity > 0 จึงจะดึงราคา/โลโก้/ข่าวได้ ไม่สามารถใส่ symbol ที่ไม่ได้ถือเพื่อใช้โควต้าเล่นได้

ข่าวเป็น 7 วันที่ปฏิทิน UTC ล่าสุด รวมวันนี้ สูงสุด 50 ข่าวที่ผ่านตัวกรอง; limit ตั้งได้ 1–50 ค่าเริ่มต้น 20 ไม่ใช่ pagination ข่าวย้อนหลังทั้งหมด

## จำนวน calls และ cache

- ใช้เพดานแอป 60 calls/นาทีตาม Dashboard ที่เลือก และไม่เกิน 30 calls/วินาที ทุก endpoint ใช้ budget เดียวกัน
- ดึง stock/symbol?exchange=US ครั้งแรก 1 API call แล้ว cache 24 ชั่วโมง เพื่อยืนยัน symbol, listing currency และ MIC ก่อนรับราคา ไม่ใช้ currency ของ company filings มาตีความเป็นสกุลราคาหุ้น หาก Finnhub ตอบ redirect จะมีอีก 1 HTTP request ไปไฟล์ catalog ที่ตรวจปลายทางแล้ว ซึ่งนับใน budget แอปด้วย
- ราคาที่ไม่อยู่ใน cache: 1 call/หุ้น ช่วงเปิด cache 15 นาที หลังปิด refresh เมื่อมี request แล้วเก็บถึงเปิดรอบถัดไป รวมวันหยุด/DST/ปิดเร็ว ดู [นโยบายและฟิลด์สำหรับ Frontend](FRONTEND_STOCK_CACHE_GUIDE.md)
- โลโก้ที่ไม่อยู่ใน cache: profile2 1 call/หุ้น, cache URL 7 วัน ไม่ดาวน์โหลดรูปผ่าน Backend
- ข่าวที่ไม่อยู่ใน cache: 1 call/หุ้น/ช่วงวันที่, cache 30 นาที เปิดเฉพาะหน้ารายละเอียดหุ้นแล้วค่อยเรียก
- เช่น ครั้งแรกมี 7 หุ้น ขอราคา+โลโก้ทั้งหมด = 1 catalog API + 1 catalog file redirect + 7 quotes + 7 profiles = 16 outbound requests หากมี redirect; เปิดข่าวอีกหนึ่งหุ้นเพิ่ม 1 call (ไม่มี network retry อัตโนมัติ) การนับ HTTP request ของแอปนี้เป็นแบบ conservative ไม่ได้อ้างว่าการดาวน์โหลด static file ใช้ API quota ของ provider
- หุ้นเดียวกันในหลายบัญชี/ผู้ใช้ใช้ public-data cache ร่วมกัน แต่ข้อมูลจำนวนหุ้น/ต้นทุนไม่เข้า cache นั้น
- FINNHUB_CALLS_PER_DAY=0 หมายถึงปิด daily cap ที่แอปตั้งเอง ไม่ใช่การรับประกันสิทธิ์/โควต้ารายวันของ Finnhub; ใส่จำนวนบวกได้หากต้องการจำกัด
- Cache/budget อยู่ใน memory ของ process เดียว restart แล้วหาย หาก deploy หลาย instances หรือมีแอปอื่นใช้ key เดียวกัน ต้องใช้ shared limiter/cache เช่น Redis หรือแบ่งงบต่อ instance ให้รวมไม่เกินแผน ห้าม restart เพื่อข้าม provider quota
- ไม่มี scheduler, polling หรือ WebSocket; TTL หมดแล้วจะ refresh เมื่อมี request เท่านั้น

## เมื่อดึงไม่ได้

### Catalog redirect และโลโก้ ADR

Catalog รองรับ redirect เพียง 1 ครั้ง เฉพาะ HTTPS ไป static2.finnhub.io/file/privatedatany2/exchange/USf.json ที่ใช้ signed Authorization query ของ provider เท่านั้น ไม่ forward X-Finnhub-Token ไป static host ไม่บันทึก/ส่ง signed URL ให้ Frontend และใช้ timeout เดียวตลอดทั้งสอง request โดเมนอื่น path อื่น และ redirect ต่อทอดจะถูกปฏิเสธ

Finnhub profile ของหุ้น ADR บางตัวคืน ticker บริษัทแม่: ASML → ASML.AS และ TSM → 2330.TW โค้ดรองรับเฉพาะคู่ที่ยืนยันนี้สำหรับโลโก้ และคืน logo.providerSymbol บอก ticker ของ profile ส่วน logo.symbol ยังเป็น ASML/TSM ตามที่ขอ ไม่ยอมรับ ticker อื่นโดยอัตโนมัติ และไม่เอาสกุลเงิน/ราคาของตลาดบริษัทแม่มาแทน USD quote ราคายังต้องผ่านการตรวจ US catalog ตามเดิม

หลังอัปเดตให้ restart Backend เพื่อใช้โค้ดใหม่และล้าง negative cache ใน memory ไม่ต้องแก้ SQL, import ใหม่ หรือแก้ key เดิมที่ถูกต้อง

| สถานะ | ความหมาย/การจัดการ |
| --- | --- |
| MARKET_DATA_CONFIG_MISSING | ยังไม่ใส่ FINNHUB_API_KEY ให้ถูก process หรือยังไม่ restart |
| PRICE/LOGO/NEWS_RATE_LIMITED | งบแอปเต็มหรือ upstream 429 รอ retryAt ไม่ยิงซ้ำถี่ |
| PRICE/LOGO/NEWS_DAILY_LIMIT | ถึง daily cap ที่ตั้งเอง รอ UTC วันใหม่ |
| PRICE/LOGO/NEWS_ACCESS_DENIED | ตรวจ key และ entitlement ของ endpoint ใน Finnhub |
| PRICE/LOGO/NEWS_NOT_AVAILABLE | ไม่พบ listing ที่ตรง, coverage ไม่รองรับ, payload ไม่ครบ หรือ upstream ขัดข้อง |
| LOGO_NOT_FOUND | ไม่มีโลโก้ใน profile; ใช้ fallback และ negative-cache 24 ชั่วโมง |
| STOCK_NOT_FOUND (HTTP 404) | ไม่พบหุ้นนอก USD ที่ผู้ใช้คนนี้ยังถือ |
| UNAUTHORIZED (HTTP 401) | Supabase login token ขาด/หมดอายุ ไม่ใช่ Finnhub key |

ราคา/โลโก้/ข่าวที่ดึงไม่ได้เป็นข้อมูลเสริม: HTTP 200 พร้อม status=UNAVAILABLE และ errorCode, ไม่ทำข้อมูล PDF หาย ถ้ามี cache เก่าที่อยู่ในขอบเขต จะใช้แบบ isStale=true พร้อม warning/retryAt และเวลา fetchedAt เดิม

stale fallback ราคาปกติได้ไม่เกิน 72 ชั่วโมงหลัง fetch และ priceAt ต้องอายุน้อยกว่า 7 วัน ยกเว้น snapshot ที่ยัง fresh ตามนโยบายตลาดปิด เก็บข้ามวันหยุดถึงรอบเปิดถัดไปได้ภายในขอบเขต 7 วัน; โลโก้ได้ไม่เกิน 30 วัน; ข่าวได้ไม่เกิน 24 ชั่วโมงและต้องเป็นช่วงวันที่เดียวกัน ไม่มีการเปลี่ยน null เป็น 0

## ข้อจำกัดก่อนเปิดใช้งานจริง

Finnhub quote ไม่ส่ง session/marketOpen/MIC/currency กลับครบใน payload ราคานี้ โค้ดตรวจตลาด/สกุลผ่าน symbol catalog แยก จึงไม่อ้างว่า quote เป็น regular session หรือ feed เดียวกับ Dime ดู priceAt เสมอ ราคาอาจต่างตามเวลา/coverage และไม่ได้รับประกันว่าหุ้นทุกตัวมีราคา โลโก้ หรือข่าว

News endpoint ตามเอกสารรองรับบริษัทในอเมริกาเหนือ ข่าวของ ADR บางตัวอาจไม่มี ข้อมูลข่าว/URL เป็นเนื้อหาภายนอก Frontend ต้องแสดงเป็น plain text ไม่ render HTML และมีลิงก์กลับสำนักข่าว

ก่อนเปิดเว็บไซต์สาธารณะ/เชิงพาณิชย์ ให้ตรวจ display, redistribution, attribution และสิทธิ์ข่าว/รูปกับ Finnhub และผู้เผยแพร่ การมี free API key ไม่ได้แปลว่ามีสิทธิ์เผยแพร่ข้อมูลทุกรูปแบบ

อ้างอิง: [Finnhub API documentation](https://finnhub.io/docs/api), [official OpenAPI schema](https://github.com/Finnhub-Stock-API/finnhub-go/blob/master/api/openapi.yaml), [Terms](https://finnhub.io/terms-of-service)
