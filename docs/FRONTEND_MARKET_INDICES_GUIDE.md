# ดัชนีตลาดล่าสุดสำหรับ frontend

## Endpoint

ข้อมูลย้อนหลัง SET/SET50 สำหรับ Analytics ใช้ TradingView แยกต่างหาก ดู
[คู่มือย้อนหลังดัชนีไทย](FRONTEND_THAI_INDEX_HISTORY_GUIDE.md)
endpoint ค่าล่าสุดในหน้านี้ยังคง Yahoo ทั้งห้าตัว ใช้ id จับคู่ข้อมูลระหว่างสอง endpoint เพราะ symbol/source อาจต่างกัน

`GET /api/v1/trades/market-indices`

ต้องส่ง `Authorization: Bearer <access_token>` เช่นเดียวกับ holdings ไม่รับ symbol/range/userId จาก query; คืนดัชนีคงที่ทั้งห้าตัวเสมอ ไม่มีการอ่านพอร์ตหรือเรียก Supabase ในตัวดึงดัชนี และไม่ต้องเพิ่ม SQL หรือ API key ใน `.env`

| id | Yahoo symbol | name | region | timeZone |
| --- | --- | --- | --- | --- |
| SP500 | ^GSPC | S&P 500 | US | America/New_York |
| NASDAQ_COMPOSITE | ^IXIC | Nasdaq Composite | US | America/New_York |
| DOW_JONES | ^DJI | Dow Jones Industrial Average | US | America/New_York |
| SET | ^SET.BK | SET Index | TH | Asia/Bangkok |
| SET50 | ^SET50.BK | SET50 Index | TH | Asia/Bangkok |

ใช้ `id` จับคู่การ์ด ไม่ยึด index ของ array Nasdaq ในชุดนี้หมายถึง Composite ไม่ใช่ Nasdaq-100; ไม่มีการใช้ ETF แทนดัชนี

## Response

ตัวอย่างย่อหนึ่ง item; response จริงมีครบห้าตัว:

```json
{
  "source": "YAHOO_FINANCE",
  "status": "COMPLETE",
  "requestedAt": "2026-10-25T09:16:36.000Z",
  "cacheTtlSeconds": 900,
  "items": [
    {
      "id": "SP500",
      "symbol": "^GSPC",
      "name": "S&P 500",
      "region": "US",
      "currency": "USD",
      "timeZone": "America/New_York",
      "source": "YAHOO_FINANCE",
      "unit": "POINTS",
      "status": "AVAILABLE",
      "value": 7623.68,
      "previousClose": 7663.43,
      "change": -39.75,
      "changePercent": -0.5187,
      "valueAt": "2026-10-23T20:38:21.000Z",
      "valueDate": "2026-10-23",
      "changeBasis": "PREVIOUS_SESSION_CLOSE",
      "previousCloseDate": null,
      "marketStatus": "UNKNOWN",
      "errorCode": null,
      "retryAt": null,
      "issues": [],
      "fetchedAt": "2026-10-25T09:16:36.000Z",
      "expiresAt": "2026-10-25T09:31:36.000Z",
      "fromCache": false,
      "isStale": false,
      "dataAgeSeconds": 131895
    }
  ]
}
```

- `value` คือค่าดัชนี หน่วยจุด ไม่ใช่ราคาหุ้นหรือมูลค่าเงิน ไม่ต้องแปลงด้วย USD/THB; `currency` เป็น metadata ของ Yahoo เท่านั้น
- `previousClose` คือราคาปิด session ก่อนหน้าที่ Yahoo ส่งมากับคำขอ `range=1d&interval=5m` ทั้งห้าตัวใช้รูปแบบเดียวกัน ไม่ใช้ `chartPreviousClose` ของกราฟหลายวันซึ่งอาจเป็นฐานคนละช่วง
- `change = value − previousClose` หน่วยจุด; `changePercent = change ÷ previousClose × 100` ปัดที่ 4 ตำแหน่ง เช่น `-0.5187` หมายถึง `-0.5187%` ไม่ต้องคูณ 100 อีก คำนวณด้วย decimal เช่นเดียวกับส่วน valuation เดิม
- Backend ใช้ค่าและความละเอียด previousClose ที่ provider ส่งมา อาจต่างเล็กน้อยจากแท่ง daily หรือหน้าเว็บที่ใช้ precision/เวลาคนละชุด
- หาก previousClose ไม่มี/ผิดรูปแบบ/เป็นศูนย์ แต่ค่าล่าสุดยังถูกต้อง item ยัง AVAILABLE แต่ previousClose/change/changePercent เป็น null พร้อม `PREVIOUS_CLOSE_UNAVAILABLE` ใน issues ห้ามใช้ chartPreviousClose หรือศูนย์เติมแทน
- `valueAt` คือเวลา observation จาก Yahoo เป็น ISO UTC ให้ frontend แปลงเป็นเวลาไทยสำหรับแสดงผล; `valueDate` เป็นวันของ observation ตาม timeZone ตลาดนั้น ไม่ใช่วันที่ backend โหลด
- `previousCloseDate` ยังเป็น null เพราะ provider metadata ไม่ได้ยืนยันวันนั้น ห้ามอนุมานเป็น valueDate ลบหนึ่งวัน เพราะมีวันหยุดตลาด
- `fetchedAt` คือเวลาที่ backend ขอสำเร็จ, `requestedAt` คือเวลารับคำขอ API รอบนี้ และ `expiresAt` คือเวลาหมด TTL ของ cache ไม่ใช่เวลาเปิดตลาด ทั้งสามไม่ใช่เวลา observation
- `marketStatus` เป็น UNKNOWN ยังไม่ได้เพิ่มปฏิทินตลาดให้ดัชนี ห้ามแสดงว่าเปิด/ปิดจาก field นี้หรือจาก isStale
- `dataAgeSeconds` คืออายุ observation ณ เวลาตอบ ใช้ประกอบป้ายวันที่ข้อมูล ไม่ใช่จำนวนวินาทีที่ cache อยู่ใน RAM

## Cache และการเรียก

- Public cache ร่วมกันทุกผู้ใช้ใน process เดียว ไม่เก็บ access token, user ID, จำนวนถือ, ต้นทุนหรือกำไรใน cache ดัชนี
- TTL 15 นาที จำกัดห้ารายการ และ single-flight ต่อดัชนี: เข้าเว็บ/เปลี่ยนผู้ใช้/หลายคนขอพร้อมกันขณะ cache ใช้ได้ ไม่ขอ Yahoo เพิ่ม แยก cache จากราคาหุ้นรายตัวและกราฟย้อนหลัง ไม่เปลี่ยน provider/การคำนวณเดิม
- เป็น on-demand ไม่มี background polling ครบ 15 นาทีแต่ไม่มีใครเรียกก็ไม่ดึงเอง ไม่มี query force-refresh ที่ bypass cache
- หาก refresh ไม่สำเร็จ อาจคืน snapshot เดิมอายุ fetch ไม่ถึง 24 ชั่วโมง พร้อม `isStale=true`, `warning`, `retryAt`, และ `STALE_CACHE` ใน issues ไม่เปลี่ยน valueAt/valueDate ให้เหมือนเป็นข้อมูลใหม่
- Cache สดไม่ได้แปลว่าข้อมูลเป็นของวันนี้: ช่วงตลาดปิดหรือวันหยุดอาจได้ observation เก่า โดย isStale=false เพราะเพิ่งขอจาก provider สำเร็จ ต้องแสดง valueDate/valueAt ด้วยเสมอ ไม่รับประกันข้อมูล real-time
- ไม่รับ observation timestamp อนาคตเกิน 60 วินาทีหรือเก่า 7 วันขึ้นไป จำกัด stale fallback ไม่ให้เกินอายุข้อมูลนี้ด้วย
- ใช้ fixed Yahoo chart endpoint และ application budget 20 คำขอ/นาทีสำหรับ index client ไม่ใช่โควต้าที่ Yahoo รับประกัน แชร์ cooldown หลัง HTTP 429/421 และเคารพ Retry-After ในขอบเขตที่ client รองรับ ไม่ยิงวนเมื่อมี retryAt; timeout 10 วินาทีต่อคำขอ ไม่เพิ่ม WebSocket
- RAM cache หายเมื่อ restart (รวม dev watch restart) และไม่แชร์ข้ามหลาย server/process ต้องวาง shared cache/limiter ก่อน scale-out หากจำเป็น

Frontend เรียกเมื่อเข้าหน้าภาพรวม และถ้าหน้ายังเปิดอยู่อาจเรียกซ้ำทุก 15 นาที หยุด polling เมื่อไม่ใช้งาน/ออกจากหน้า ไม่ต้องเรียกห้าครั้งแยกดัชนี เพราะ endpoint เดียวคืนครบแล้ว Response ใช้ `Cache-Control: no-store` เพื่อไม่ให้ browser/intermediary เก็บ response ที่ผ่าน authentication; ไม่กระทบ public cache ภายใน backend

## ข้อมูลขาดและ error

HTTP 200 ยังคงคืนห้ารายการ: root status COMPLETE เมื่อค่าดัชนีทั้งห้าพร้อม, PARTIAL เมื่อพร้อมบางตัว และ UNAVAILABLE เมื่อไม่มีตัวใดพร้อม สถานะนี้ไม่ใช่การรับประกันความสดหรือความครบของ baseline รายวัน ตรวจ isStale และ changePercent ของแต่ละ item ด้วย ส่วน authentication ที่ไม่ผ่านยังเป็น 401 ตาม middleware เดิม

UNAVAILABLE item คง identity แต่ value/previousClose/change/changePercent/valueAt/valueDate เป็น null พร้อม errorCode และ retryAt; อย่าแสดงศูนย์แทน ตัวอื่นที่พร้อมยังแสดงได้ตามปกติ

- INDEX_RATE_LIMITED: ดู limitSource=BACKEND หรือ PROVIDER, reason และ providerStatus เช่น 429/421 เพื่อแยกแหล่งที่จำกัด
- INDEX_ACCESS_DENIED: provider ไม่อนุญาต
- INDEX_NOT_AVAILABLE: network/timeout/HTTP error อื่น โดย reason อาจเป็น NETWORK_ERROR/PROVIDER_TIMEOUT/PROVIDER_HTTP_ERROR
- INDEX_RESPONSE_INVALID: symbol/ประเภท INDEX/สกุลเงิน/ตลาด/เวลา/ค่าดัชนีไม่ผ่านการตรวจ
- หากเป็น stale fallback ให้ดู warning แทน errorCode ซึ่งยังเป็น null ของ snapshot ที่เคยสำเร็จ; diagnostics reason/providerStatus/limitSource ส่งเมื่อ UNAVAILABLE ไม่ได้ส่งครบใน stale snapshot

## เทียบกับพอร์ต

ใช้ changePercent เทียบกับเปอร์เซ็นต์เปลี่ยนแปลงรายวันของพอร์ต/ประเภทสินทรัพย์ ไม่ใช่ unrealized P&L จากต้นทุนหรือการเปลี่ยน marketValue จากเงินเข้าออก เช่น พอร์ต +1.20% เทียบดัชนี +0.80% ต่างกัน 0.40 จุดเปอร์เซ็นต์ ไม่ใช่กำไรเพิ่ม 0.40%

ตรวจวันฐาน/เวลาของพอร์ตก่อนเทียบ สหรัฐฯ ใช้ New York ไทยใช้ Bangkok และกองทุนอาจประกาศ NAV คนละวัน หากวันที่ไม่ตรงกันให้แสดงค่าข้างกันพร้อมวันที่หรือระบุ “ข้อมูลคนละวัน” ไม่สรุปว่าพอร์ตชนะตลาดวันนี้ ระบบนี้ยังไม่คำนวณ benchmark spread, ผลตอบแทนย้อนหลัง, total return รวมปันผล หรือผลค่าเงินเพิ่ม และไม่แก้ผล daily-change เดิม

## ทดสอบ

`node --use-system-ca scripts/verification/verify-market-indices.cjs` ใช้ Yahoo จริงโดยไม่อ่านฐานข้อมูล/ไม่ใช้ API key แสดงค่าทั้งห้าตัวและตรวจว่าคำขอซ้ำไม่มี provider calls เพิ่ม; อาจล้มเหลวได้เมื่อ Yahoo จำกัดการเข้าถึง

`npm test` ครอบคลุม fixed symbols, previousClose ไม่ใช้ฐานหลายวัน, เวลา/identity ผิด, ค่า 0/ติดลบ/ขาด baseline, concurrent cache, partial outage, stale fallback, 429 และ endpoint authentication/cache ข้ามผู้ใช้

Yahoo endpoint นี้ไม่ใช่ official public API ที่รับประกัน SLA การเปิดเว็บให้บุคคลอื่น/เชิงพาณิชย์ต้องตรวจสิทธิ์ข้อมูลและเงื่อนไขผู้ให้บริการก่อน
