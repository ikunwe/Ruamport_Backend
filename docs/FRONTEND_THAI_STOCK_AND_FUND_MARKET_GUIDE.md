# Frontend: ราคาหุ้นไทยจาก Yahoo Finance และ NAV กองทุนจาก SEC Open API

## ขอบเขตและสถานะ

เพิ่มราคา/NAV และ unrealized valuation สำหรับ THAI_STOCK / MUTUAL_FUND ที่เป็น THB และ quantity > 0 โดยใช้รายการที่ import แล้วของผู้ใช้ที่ login อยู่เท่านั้น หุ้นนอกยังใช้ Finnhub และ cache ตาม session เดิม ไม่เพิ่ม endpoint ซื้อขาย ไม่แก้ต้นทุน/ยอดเงิน/จำนวนหน่วยจาก PDF และไม่มี SQL ใหม่

Yahoo หุ้นไทยทดสอบกับข้อมูล ASK.BK จริงแล้ว ส่วน SEC ต้องกรอก subscription key ก่อน จึงจะตรวจสอบ live กับบัญชีผู้ใช้ได้ การทดสอบ mock ไม่ใช่การยืนยัน entitlement หรือ NAV class ที่มีจริงในบัญชีนั้น หากรูปแบบ SEC response ไม่ตรงที่ตรวจ จะคืนสถานะ UNAVAILABLE ไม่เดาตัวเลขแทน

includeLogos=true รองรับ URL โลโก้หุ้นไทยจาก SET สำหรับใช้งานส่วนตัวแล้ว (ไม่ใช่ Yahoo) ดู [คู่มือโลโก้หุ้นไทยและ fallback](FRONTEND_THAI_STOCK_LOGO_GUIDE.md) กองทุน THB ที่ยังถือมีโลโก้ บลจ. ผ่าน SEC/AIMC/Logo.dev ดู [คู่มือโลโก้กองทุน](FRONTEND_MUTUAL_FUND_LOGO_GUIDE.md) และ endpoint ข่าวยังรองรับเฉพาะหุ้นนอก

## ค่าก่อนหน้าและการเปลี่ยนแปลงรายวัน

เรียก GET /api/v1/trades/holdings?includeMarket=true พร้อม Supabase Bearer token ตามเดิม ฟิลด์ต่อไปนี้อยู่ใน items[].marketValuation.quote ไม่ใช่ใน costBasis หรือยอดกำไรส่วนตัว ไม่ต้องเพิ่ม SQL, env หรือ import ใหม่ และไม่เปลี่ยนหุ้นนอก

หุ้นไทย ตัวอย่างราคาล่าสุด 9.60 เทียบปิดก่อนหน้า 10 บาท:

```json
{
  "source": "YAHOO_FINANCE",
  "currency": "THB",
  "price": 9.6,
  "previousClose": 10,
  "previousCloseDate": "2026-10-20",
  "change": -0.4,
  "changePercent": -4
}
```

previousClose เป็นราคาปิด THB/หุ้นของแท่ง daily วันที่ก่อนวันที่ quote (อิงวันไทย) เลือกจาก timestamp/close ของกราฟ 5 วันคำขอเดิม ไม่ใช้ chartPreviousClose ซึ่งอาจเป็นฐานเริ่มต้นของช่วงกราฟ ไม่ใช่ปิดวันก่อน ไม่ใช้แท่งของวันเดียวกับ quote วันก่อนหน้าคือวันซื้อขายที่มีข้อมูล ไม่จำเป็นต้องเป็นเมื่อวานตามปฏิทิน หากช่วงกราฟไม่มีแท่งก่อนหน้าที่ใช้ได้จะส่ง null ไม่เรียก API เพิ่มเพื่อย้อนหลังไกลขึ้น

กองทุน ตัวอย่าง NAV 11 บาท เทียบ 10 บาท:

```json
{
  "source": "SEC_OPEN_API",
  "currency": "THB",
  "price": 11,
  "navPerUnit": 11,
  "navDate": "2026-10-20",
  "previousNav": 10,
  "previousNavDate": "2026-10-19",
  "change": 1,
  "changePercent": 10
}
```

navDate คือวันที่ NAV ล่าสุด และ previousNavDate คือวันประกาศก่อนหน้านั้นที่พบสำหรับ project/class เดียวกันใน response ย้อนหลัง 14 วันเดิม previousNav เป็น THB/หน่วย ไม่ใช่มูลค่ากองทุนรวม ไม่ใช้ buy_price/sell_price หรือ net_asset มาแทน NAV กองทุนไม่มี previousClose ให้ใช้ previousNav

Frontend ควรแสดง “เปลี่ยนแปลง NAV เทียบ 19 ต.ค.” หรือแสดงวันที่ทั้งสองวัน ไม่รับประกันว่าเป็นวันนี้กับเมื่อวาน NAV อาจเว้นช่วงวันหยุด และเป็น NAV ที่ประกาศไม่ใช่ราคาเรียลไทม์

ทั้งสองประเภทคำนวณ:

```text
change = ค่าล่าสุด − ค่าก่อนหน้า
changePercent = change ÷ ค่าก่อนหน้า × 100
```

- change หน่วย THB ต่อหุ้น/หน่วย ไม่ได้คูณ quantity ไม่ใช่กำไรต่อวันของผู้ใช้
- changePercent ส่งเป็นเปอร์เซ็นต์แล้ว เช่น -4 คือ -4% ไม่ต้องคูณ 100 ซ้ำ ไม่ใช้ unrealizedPnlPercent ซึ่งเทียบต้นทุน
- ส่วนต่างใช้ decimal arithmetic แสดงสูงสุด 8 ตำแหน่ง เปอร์เซ็นต์ปัด 4 ตำแหน่ง Frontend เลือกรูปแบบแสดงได้
- ราคาปิดจากแท่ง Yahoo จะปรับตาม priceHint ที่ provider ระบุ (เมื่อถูกต้อง) เพื่อลดเศษ float32 เช่น 9.600000381 แทน 9.60 ไม่เดา tick size และไม่เปลี่ยนราคา/NAV ล่าสุดหรือต้นทุนจาก PDF
- ค่าก่อนหน้าต้องเป็นตัวเลข finite > 0 หากไม่มี/ผิดรูปแบบ/เป็นศูนย์/มีข้อมูลขัดกันของวันก่อนหน้า ค่าก่อนหน้าและ change/changePercent เป็น null อย่าแสดง 0% ให้ใช้ — ส่วนวันที่ก่อนหน้าอาจยังส่งได้หากรู้วันที่แต่ค่าผิดปกติ
- ไม่ข้ามวันก่อนหน้าที่ค่าผิดปกติไปเลือกวันเก่ากว่าแล้วเรียกว่า daily change ค่าล่าสุดยัง AVAILABLE และใช้คำนวณมูลค่าได้หากตัวล่าสุดถูกต้อง กติกาที่ตัวล่าสุดผิดปกติยังคงเดิม
- change/changePercent=0 เป็นข้อมูลที่ถูกต้อง ให้แสดง 0% ไม่ใช่ — ถ้าราคา/NAV UNAVAILABLE ฟิลด์รายวันเป็น null
- Cache ใช้ snapshot เดียวกับราคา/NAV ไม่เพิ่มจำนวนคำขอหรือเปลี่ยน TTL อ่าน isStale, warning, fetchedAt, priceAt/navDate และ expiresAt ประกอบ หาก fallback ข้อมูลเก่า ค่ารายวันและวันที่ก็เป็นของ snapshot เก่า ไม่แปะว่าเป็น “วันนี้” อัตโนมัติ
- ข้อมูลก่อนหน้ามาจากช่วงที่ provider ส่งให้ ไม่ใช่การยืนยันว่ามีประวัติครบหรือได้ปรับ corporate action ทุกกรณี

## การตั้งค่า Backend

.env เพิ่มช่องนี้แล้ว:

~~~env
SEC_API_KEY=
~~~

ใส่ Primary key หรือ Secondary key ของ SEC เพียงตัวเดียวในช่องเดียวกัน ไม่ต้องเพิ่มทั้งสอง key; ใช้ Secondary เป็นสำรองสำหรับ rotation ไม่ใช่สลับเพื่อข้าม quota ไม่ใช้ Supabase key, Finnhub key, รหัสผ่านหรือ PIN ของบัญชีซื้อขาย อย่าส่ง key ให้ Frontend หรือในแชต

ชื่อค่าปรับ optional (มี default ในโค้ดและ .env.example):

~~~env
THAI_PRICE_CACHE_TTL_SECONDS=900
FUND_NAV_CACHE_TTL_SECONDS=3600
~~~

Yahoo ไม่ต้องมี API key และไม่ต้องติดตั้ง Python/เปิดบัญชีโบรกเกอร์เพิ่ม โค้ดเรียก chart endpoint ที่กำหนดตายตัวจาก Node โดยตรง ไม่ scrape HTML ไม่ให้ client ส่ง URL มาสั่ง Backend fetch

กรอก key แล้ว restart npm run dev ทั้ง SEC key และการตั้งค่าอ่านตอนเริ่ม process

## Endpoint

~~~http
GET /api/v1/trades/holdings?includeMarket=true
Authorization: Bearer <Supabase access_token>
~~~

เพิ่ม includeFx=true / includeLogos=true ได้ แต่ไม่จำเป็นต่อราคา/NAV ของสินทรัพย์ THB includeFx ยังคงเป็นการแปลงข้อมูลหุ้นนอก USD ตาม Frankfurter ไม่ได้ทำให้ Thai/fund valuation มี USD โดยอัตโนมัติ

ไม่ส่ง includeMarket หรือส่ง false: response เดิม ไม่มี network call ไป market providers ไม่มีการเรียกด้วย arbitrary symbol จาก query การเลือกหุ้น/กองทุนใช้ holdings ของ authenticated user เท่านั้น

ไม่ต้องเปลี่ยน endpoint/import ใหม่หลังมี key

## ฟิลด์ที่ Frontend ใช้

| ข้อมูล | ฟิลด์ |
| --- | --- |
| ชื่อสินทรัพย์เดิม | items[].symbol / fundName |
| จำนวนหุ้น/หน่วยที่ถือ | items[].quantity |
| ต้นทุนเฉลี่ยเดิม | items[].costBasis[] แถว currency=THB → averageCostPerUnit |
| ต้นทุนคงเหลือเดิม | items[].costBasis[] แถว currency=THB → remainingCost |
| ราคาหุ้นไทยต่อหุ้น | items[].marketValuation.quote.price |
| เวลาราคาหุ้นไทย | items[].marketValuation.quote.priceAt |
| NAV ต่อหน่วยกองทุน | items[].marketValuation.quote.navPerUnit (เท่ากับ quote.price) |
| วันที่ NAV | items[].marketValuation.quote.navDate เป็น YYYY-MM-DD |
| รหัส SEC ที่จับคู่แล้ว | quote.projectId / fundClassName |
| มูลค่าที่ถือ | items[].marketValuation.thb.marketValue |
| ต้นทุนคงเหลือที่ใช้เทียบ | items[].marketValuation.thb.remainingCost |
| กำไร/ขาดทุนที่ยังไม่ขาย | items[].marketValuation.thb.unrealizedPnl |
| เปอร์เซ็นต์กำไร/ขาดทุน | items[].marketValuation.thb.unrealizedPnlPercent |
| ยอดรวมหุ้นไทย | thaiStockValuation.thb |
| ยอดรวมกองทุน | mutualFundValuation.thb |

แยก assetType ก่อนเลือกสกุล: หุ้นนอกอ่าน marketValuation.usd ส่วนหุ้นไทย/กองทุนอ่าน marketValuation.thb ห้าม hardcode ทุกตัวเป็น USD สำหรับสองประเภทใหม่นี้ usd=null แม้ขอ includeFx

ยอดรวมใหม่แต่ละชุดมี heldPositionCount, pricedPositionCount, missingPriceCount, incompleteCostCount, stalePriceCount, isComplete, cacheTtlSeconds, limitations และ thb ที่มี marketValue, remainingCost, unrealizedPnl, unrealizedPnlPercent, availableMarketValue

thaiStockValuation มี oldestPriceAt/newestPriceAt ส่วน mutualFundValuation มี oldestNavDate/newestNavDate อย่านำวัน NAV ไปแสดงเป็นเวลา tick ราคาตลาด

offshoreValuation ยังคงรวมเฉพาะหุ้นนอก USD เหมือนเดิม ไม่มี combined portfolio total ข้ามประเภท/สกุลใหม่ ห้ามรวม historical PDF THB กับ converted current-rate THB เป็นยอดเดียวโดยไม่แยกฐานเงิน

## การคำนวณ

- มูลค่าหุ้นไทย = quantity × ราคาต่อหุ้นจาก Yahoo; เทียบกับ remainingCost THB แบบ FIFO ที่มีอยู่
- มูลค่ากองทุน = quantity × last_val (NAV ต่อหน่วย) จาก SEC; เทียบ remainingCost THB แบบ Moving Weighted Average ที่มีอยู่
- PnL = marketValue − remainingCost และ percent = PnL ÷ remainingCost × 100
- ใช้ decimal arithmetic คำนวณก่อนปัดค่าเงินส่งกลับ ไม่รวมเลขที่ปัดแล้วจากการ์ดเอง
- ไม่ใช้ net_asset (มูลค่าทรัพย์สินทั้งกอง), sell_price (ราคาเสนอขาย) หรือ buy_price (ราคารับซื้อคืน) แทน NAV
- ผลเป็นมูลค่าประเมินตามราคาหรือ NAV ไม่ใช่ยอดขาย/ขายคืนสุทธิหลังค่าธรรมเนียม ไม่รวมปันผลหรือ corporate actions อัตโนมัติ

## ตัวอย่างแถวหุ้นไทย (ข้อมูลสมมุติ)

~~~json
{
  "assetType": "THAI_STOCK",
  "symbol": "ASK",
  "currency": "THB",
  "quantity": 100,
  "costBasisMethod": "FIFO",
  "marketValuation": {
    "status": "CALCULATED",
    "currency": "THB",
    "quantity": 100,
    "quote": {
      "status": "AVAILABLE",
      "source": "YAHOO_FINANCE",
      "kind": "STOCK_PRICE",
      "symbol": "ASK",
      "providerSymbol": "ASK.BK",
      "providerExchange": "SET",
      "currency": "THB",
      "price": 9.6,
      "priceAt": "2026-10-21T09:37:58.000Z",
      "cachePolicy": "FIXED_TTL",
      "marketOpen": null,
      "session": "PROVIDER_QUOTE",
      "dataDelayMinutes": null,
      "fetchedAt": "2026-10-21T10:00:00.000Z",
      "expiresAt": "2026-10-21T10:15:00.000Z",
      "fromCache": false,
      "isStale": false
    },
    "usd": null,
    "thb": {
      "currency": "THB",
      "marketValue": 960,
      "remainingCost": 800,
      "unrealizedPnl": 160,
      "unrealizedPnlPercent": 20
    },
    "issues": []
  }
}
~~~

## ตัวอย่างแถวกองทุน (บางส่วน เป็นข้อมูลสมมุติ ไม่ใช่การยืนยัน NAV จริง)

~~~json
{
  "assetType": "MUTUAL_FUND",
  "symbol": "KKP US500-UH-E",
  "currency": "THB",
  "quantity": 10,
  "costBasisMethod": "MOVING_WEIGHTED_AVERAGE",
  "marketValuation": {
    "status": "CALCULATED",
    "currency": "THB",
    "quantity": 10,
    "quote": {
      "status": "AVAILABLE",
      "source": "SEC_OPEN_API",
      "kind": "NAV",
      "symbol": "KKP US500-UH-E",
      "providerSymbol": "KKPUS500-UH-E",
      "projectId": "M0123_2563",
      "fundClassName": "KKPUS500-UH-E",
      "currency": "THB",
      "price": 12.3456,
      "navPerUnit": 12.3456,
      "priceAt": null,
      "navDate": "2026-10-20",
      "providerUpdatedAt": null,
      "cachePolicy": "PUBLISHED_NAV_TTL",
      "fetchedAt": "2026-10-21T10:00:00.000Z",
      "expiresAt": "2026-10-21T11:00:00.000Z",
      "fromCache": false,
      "isStale": false
    },
    "usd": null,
    "thb": {
      "currency": "THB",
      "marketValue": 123.46,
      "remainingCost": 100,
      "unrealizedPnl": 23.46,
      "unrealizedPnlPercent": 23.456
    },
    "issues": []
  }
}
~~~

NAV ส่งวันที่เท่านั้น priceAt=null ตั้งใจไม่สร้าง timestamp สมมุติให้ดูเหมือน realtime NAV ของกองทุนลงทุนต่างประเทศอาจประกาศช้ากว่าวันลงทุน/วันปัจจุบัน จึงแสดงว่า “มูลค่าตาม NAV วันที่ …” ไม่เรียกว่า “ราคาตอนนี้”

## การจับคู่และ validation

Yahoo ใช้ symbol จากรายการที่ถือ + .BK ตรวจ symbol/currency THB/exchange/type EQUITY และเวลาให้ตรง ไม่ข้ามไปใช้ราคาตลาดอื่น/สกุลอื่นเมื่อไม่พบ ครอบคลุมหุ้นสามัญที่ Yahoo ส่งชนิด EQUITY; ไม่รับประกันทุกหลักทรัพย์ไทย/ETF/DR จะมีข้อมูลที่ใช้ได้

SEC เรียก /v2/fund/general-info/profiles เพื่อจับคู่ proj_id + fund_class_name แล้ว /v2/fund/daily-info/nav โดยส่งช่วง 14 วันย้อนหลังถึงวันที่ไทยปัจจุบัน

การเทียบชื่อไม่สนตัวพิมพ์ใหญ่เล็ก/ช่องว่าง แต่ยังคงความต่าง suffix ของ class เช่น -E, -A, RMF, SSF ห้ามนำ class อื่นหรือกองทุนหลักมาทดแทน ไม่ทำ fuzzy match หากมีหลายโครงการตรงชื่อจะหยุดด้วย NAV_FUND_AMBIGUOUS กองที่ไม่มี class ต้องมี main/-/ชื่อ class ว่างชัดเจนและชื่อย่อโครงการตรงตัว

อ่าน pagination จนครบภายในขอบเขต 5 หน้า/คำค้น ถ้า cursor วนซ้ำ ข้อมูลไม่ครบ หรือเกินขอบเขต จะไม่เลือก NAV จากข้อมูลบางส่วน NAV เลือกวันที่ล่าสุดที่ตรงกอง/class และตรวจค่าบวก วันที่จริง ไม่เกินวันที่ไทยปัจจุบัน อายุไม่เกิน 14 วัน ถ้าวันล่าสุดมีตัวเลขผิด/ซ้ำขัดแย้งจะไม่เงียบไปใช้วันเก่า

## Cache / API limits

- หุ้นไทย: fixed TTL 15 นาทีทุกช่วงเวลา ยังไม่มี calendar หุ้นไทย/ช่วงพักกลางวัน/วันหยุดแบบ session-aware ไม่ได้นำ calendar สหรัฐฯ มาใช้กับ SET และไม่รับรองราคา realtime
- NAV: cache 1 ชั่วโมง แม้เป็น NAV รายวันก็ยังตรวจใหม่ได้เมื่อมี request หลัง TTL เพื่อรองรับการประกาศ/แก้ไขภายหลัง ไม่ล็อกค่าทั้งวัน
- การจับคู่กองทุน: cache 7 วัน; snapshot สาธารณะใช้ร่วมกันใน process เดียว ไม่ cache จำนวนหน่วย/ต้นทุนผู้ใช้
- Stale fallback สูงสุด 72 ชั่วโมงหลัง fetch โดยราคาหุ้นยังต้องอายุน้อยกว่า 7 วัน และ NAV date ยังต้องอยู่ในช่วง 14 วัน
- fromCache กับ isStale คนละเรื่อง วันที่ NAV ไม่จำเป็นต้องเท่ากับวันที่ fetch ให้แสดง navDate เสมอ
- App limits ตั้งไว้ conservative: Yahoo 20 outbound/minute, SEC 30/minute เป็นข้อจำกัดของแอป ไม่ใช่การประกาศโควต้าของ provider ทุกหน้าที่โหลดใช้ budget ร่วมกันใน provider เดียว
- รับมือ SEC HTTP 421/429 และ Yahoo 429 พร้อม retryAt/backoff ไม่ auto-retry หรือสลับ key เพื่อหลบ quota
- ไม่มี background job; Frontend เปิดหน้าพอร์ต/กลับแท็บ/รีเฟรชจึงขอ ไม่ต้อง poll ถี่กว่า expiresAt เคารพ retryAt
- Cache/limiter อยู่ใน memory หาก deploy หลาย instances ต้องเพิ่ม shared infrastructure หรือแบ่งงบเอง ไม่มีประวัติราคาใหม่ลง DB

## สถานะและ error ที่ต้องรองรับ

marketValuation.status ใช้ CALCULATED, PRICE_UNAVAILABLE, COST_INCOMPLETE, INCOMPLETE, NOT_HELD, UNSUPPORTED เหมือนรูปแบบเดิม กองทุน NAV ดึงไม่ได้ก็ใช้ PRICE_UNAVAILABLE และอ่าน quote.errorCode เพื่อทราบสาเหตุ

| quote.errorCode | Frontend ควรทำ |
| --- | --- |
| SEC_API_KEY_MISSING | ระบบยังไม่ตั้ง key แสดง NAV ไม่พร้อม ไม่ให้ผู้ใช้กรอก key ใน Frontend |
| NAV_ACCESS_DENIED | Backend key/สิทธิ์ SEC ไม่ผ่าน แสดง unavailable |
| NAV_FUND_NOT_FOUND | ไม่พบกอง/class ที่ตรง ให้ตรวจชื่อเดิม ไม่เอากองอื่นแทน |
| NAV_FUND_AMBIGUOUS | ชื่อจับคู่ได้หลายโครงการ ยังไม่เลือกอัตโนมัติ |
| NAV_LOOKUP_INCOMPLETE | ข้อมูลหน้าต่อไปไม่ครบ/เกินขอบเขต ยังไม่ใช้ผลบางส่วน |
| NAV_RESPONSE_INVALID | รูปแบบข้อมูล/ค่า NAV ล่าสุดไม่ผ่าน validation |
| NAV_NOT_AVAILABLE | ไม่มี NAV ในช่วงที่รองรับหรือ upstream ขัดข้อง |
| PRICE_NOT_AVAILABLE | Yahoo ไม่พร้อม/ข้อมูลไม่ตรง/เกินอายุ |
| PRICE_ACCESS_DENIED | Yahoo ปฏิเสธคำขอ |
| PRICE_RATE_LIMITED / NAV_RATE_LIMITED | รอ retryAt อย่ายิงซ้ำทันที |

ปัญหา provider เป็น advisory HTTP 200 พร้อมข้อมูลพอร์ตเดิม ถ้าไม่มีราคา marketValue/PnL=null ไม่ใช่ 0 ถ้าไม่รู้ต้นทุนแต่มีราคา ยังแสดง marketValue ได้แต่ PnL=null ถ้าต้นทุน 0 เปอร์เซ็นต์=null

ยอดรวมถ้าราคาไม่ครบจะส่ง isComplete=false และ marketValue/PnL รวมเป็น null; availableMarketValue คือเฉพาะส่วนที่ทราบราคา ต้องติดป้าย “ยอดบางส่วน” ไม่แสดงเป็นทั้งพอร์ต

## ทดสอบหลังใส่ SEC key

~~~powershell
node --use-system-ca --env-file=.env scripts/verification/verify-domestic-market.cjs
~~~

ทดสอบ ASK และ KKP US500-UH-E ผ่าน service จริง ไม่เข้าถึง Supabase ไม่บันทึก PDF/ธุรกรรม ไม่แสดง key ถ้า SEC ยังไม่ใส่ key จะเห็น SEC_API_KEY_MISSING ตามจริง หากใส่แล้วแต่ผิด class/contract/สิทธิ์ จะรายงาน errorCode ก่อนปรับให้ตรง response จริง ไม่ควรประกาศว่ากองทุนเชื่อมสำเร็จจนผ่านขั้นนี้

## ข้อจำกัดข้อมูล

Yahoo endpoint เป็น unofficial ไม่มี SLA และอาจเปลี่ยน/ถูกบล็อกได้ การใช้ได้โดยไม่ซื้อ API key ไม่ใช่สิทธิ์เผยแพร่ต่ออัตโนมัติ ต้องตรวจเงื่อนไขก่อนเปิดหลายผู้ใช้/เชิงพาณิชย์ ส่วน SEC ตรวจข้อตกลงของ subscription ด้วย

อ้างอิง: [SEC Developer Portal ใหม่](https://secopendata.sec.or.th/sec-open-apis?user=developer), [ข้อจำกัด Yahoo ผ่านเครื่องมือชุมชน](https://ranaroussi.github.io/yfinance/), [SEC ตัวอย่าง schema mirror ที่ใช้เตรียม contract — ไม่ใช่เอกสารทางการ ต้องตรวจ response จริง](https://github.com/Sitthinut/sec-open-data-api-spec)
