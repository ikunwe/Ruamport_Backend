# Frontend: Finnhub ราคา โลโก้ ข่าว และกำไรขาดทุนหุ้นนอก

Backend เปลี่ยน provider เป็น FINNHUB แล้ว [วิธีใส่ key และเริ่มใช้งาน](FINNHUB_SETUP_GUIDE.md)

อัปเดต cache ตามตลาดเปิด/ปิด: [Frontend session-aware stock cache](FRONTEND_STOCK_CACHE_GUIDE.md) — อ่าน expiresAt จริงและ marketSchedule แทนการกำหนดทุกช่วงเป็น 15 นาที

## สิ่งที่ Frontend ต้องเปลี่ยน

- ใช้ holdings endpoint และฟิลด์ราคา/โลโก้เดิมได้ โดย source เป็น FINNHUB
- quote.interval=null, session=PROVIDER_QUOTE, marketOpen=null: ห้ามระบุว่าเป็นราคา regular session หรือตลาดเปิดจากข้อมูลนี้
- providerMicCode เป็น MIC ที่ตรวจจาก catalog ของ Finnhub ส่วน micCode/holdings.exchange ยังคงจาก PDF; providerExchange=null ไม่ได้เดาชื่อตลาด
- ใช้ค่า source/session จาก response และกำหนด CSP/img allowlist เป็น static2.finnhub.io หรือ static.finnhub.io ตาม URL ที่ได้; ภาพข่าวเป็นโดเมน publisher ภายนอก ให้ใช้นโยบายรูปที่เหมาะกับแอปหรือไม่แสดงรูป
- ข่าวใช้ endpoint ใหม่ เปิดหน้ารายละเอียดหุ้นแล้วค่อยขอ ไม่ได้แถมใน holdings
- ต้นทุนเดิม, PDF THB/USD, costBasis, amounts, moneyTotals, stockMoneyTotals และ Frankfurter ไม่เปลี่ยน ไม่ต้อง import ใหม่

## Endpoints

ทุก request ต้องมี Authorization: Bearer <Supabase access_token>

~~~http
GET /api/v1/trades/holdings
GET /api/v1/trades/holdings?includeMarket=true&includeLogos=true&includeFx=true
GET /api/v1/trades/stocks/AMD/news?exchange=XNAS&limit=20
~~~

includeMarket/includeLogos/includeFx เป็น opt-in แยกกัน ค่าเริ่มต้น false ไม่มีการเรียกราคา/โลโก้/FX ถ้าไม่ขอ includeClosed=true ยังใช้ดูประวัติได้ แต่หุ้นขายหมดไม่เรียก market data

## ราคาและมูลค่าพอร์ต

### ราคาปิดก่อนหน้าและการเปลี่ยนแปลงรายวันของหุ้นนอก

เรียก GET /api/v1/trades/holdings?includeMarket=true พร้อม Bearer token ตามเดิม เพิ่มฟิลด์ใน items[].marketValuation.quote จาก Finnhub /quote คำขอเดียวกัน ไม่เพิ่ม API call, SQL หรือ env ไม่เปลี่ยนจำนวนหุ้น/ต้นทุน/Unrealized/Realized PnL และไม่เปลี่ยนหุ้นไทยหรือกองทุน:

```json
{
  "price": 150,
  "currency": "USD",
  "previousClose": 155,
  "change": -5,
  "changePercent": -3.2258
}
```

| ฟิลด์ | Finnhub | ความหมาย |
|---|---|---|
| previousClose | pc | ราคาปิดวันซื้อขายก่อนหน้า USD/หุ้น ไม่จำเป็นต้องเป็นวันปฏิทินเมื่อวาน |
| change | d | ส่วนต่างราคาต่อหุ้น USD ตาม provider มีค่าบวก ลบ หรือศูนย์ |
| changePercent | dp | เปอร์เซ็นต์เปลี่ยนแปลงตาม provider เช่น -3.2258 แสดง -3.23% ไม่คูณ 100 ซ้ำ |

ส่งค่าของ provider โดยตรง ไม่คำนวณทดแทนเมื่อข้อมูลหาย แต่ละฟิลด์ที่ไม่มี/ผิดชนิด/ไม่ finite เป็น null และ previousClose ต้องมากกว่า 0 จึงใช้ได้ ราคาล่าสุดที่ถูกต้องยัง AVAILABLE ได้แม้ข้อมูลรายวันไม่ครบ หากราคา UNAVAILABLE ทั้งสามฟิลด์เป็น null ใช้ — ไม่แทนด้วยศูนย์ ส่วนค่า change/changePercent=0 เป็นข้อมูลที่ใช้ได้จริง

ค่านี้เป็นการเปลี่ยนแปลงราคาหุ้น ไม่ใช่กำไรต่อวันของพอร์ตหรือ unrealizedPnlPercent ที่เทียบต้นทุนส่วนตัว ไม่คูณจำนวนหุ้น/ค่าเงินให้อัตโนมัติ แม้ includeFx=true ค่า quote ยังเป็น USD และเปอร์เซ็นต์ไม่เปลี่ยน

ใช้ snapshot/cache เดียวกับราคา อ่าน priceAt, fetchedAt, isStale, warning, expiresAt ประกอบ หาก fallback ราคาเก่า ค่ารายวันก็เก่าตามราคา ไม่ควรแสดงว่าเป็นของวันนี้เสมอไป ระบบไม่รับประกัน real-time/regular-session จากฟิลด์นี้ ระหว่างตลาดปิดแสดงเป็นการเปลี่ยนแปลงของข้อมูลการซื้อขายล่าสุด ไม่ reset เป็นศูนย์ตอนเที่ยงคืนไทย

ตัวอย่างบางส่วนของ item (ตัวเลขสมมุติ):

~~~json
{
  "symbol": "AMD",
  "assetType": "OFFSHORE_STOCK",
  "exchange": "XNAS",
  "currency": "USD",
  "quantity": 2,
  "marketValuation": {
    "status": "CALCULATED",
    "currency": "USD",
    "quantity": 2,
    "quote": {
      "status": "AVAILABLE",
      "source": "FINNHUB",
      "symbol": "AMD",
      "micCode": "XNAS",
      "providerMicCode": "XNGS",
      "providerExchange": null,
      "currency": "USD",
      "price": 150,
      "priceAt": "2026-10-20T14:59:00.000Z",
      "interval": null,
      "session": "PROVIDER_QUOTE",
      "marketOpen": null,
      "fetchedAt": "2026-10-20T15:00:00.000Z",
      "expiresAt": "2026-10-20T15:15:00.000Z",
      "fromCache": false,
      "isStale": false
    },
    "usd": {
      "marketValue": 300,
      "remainingCost": 200,
      "unrealizedPnl": 100,
      "unrealizedPnlPercent": 50
    },
    "thb": {
      "currency": "THB",
      "marketValue": 10049.4,
      "remainingCost": 6699.6,
      "unrealizedPnl": 3349.8,
      "unrealizedPnlPercent": 50
    },
    "issues": []
  },
  "logoUrl": "https://static2.finnhub.io/file/publicdatany/finnhubimage/stock_logo/AMD.png",
  "logo": {
    "status": "AVAILABLE",
    "source": "FINNHUB",
    "symbol": "AMD",
    "micCode": "XNAS",
    "providerSymbol": "AMD",
    "url": "https://static2.finnhub.io/file/publicdatany/finnhubimage/stock_logo/AMD.png",
    "fetchedAt": "2026-10-20T15:00:00.000Z",
    "expiresAt": "2026-10-27T15:00:00.000Z",
    "fromCache": false,
    "isStale": false
  }
}
~~~

THB ในตัวอย่างใช้ Frankfurter rate=33.498 จาก fx ใน response เดียวกัน ไม่ได้ใช้ historical THB ของ PDF มาปนกับราคาปัจจุบัน

- marketValue = quantity × quote.price
- remainingCost = costBasis USD ที่คำนวณ Compressed FIFO อยู่แล้ว ใช้ grossAmount ไม่รวมค่าคอม ไม่ใช่ buy สะสม − sell สะสม
- unrealizedPnl = marketValue − remainingCost; percent = PnL ÷ remainingCost × 100
- THB = ค่าข้างบน × fx.rate เดียวกัน เป็นกำไรขาดทุนจากราคาที่แปลงตามเรทปัจจุบัน ไม่ใช่ FX PnL หรือ total return
- ถ้าไม่มี FX จะได้ thb=null แต่ USD ยังใช้ได้; ถ้าต้นทุนเป็น 0 เปอร์เซ็นต์=null
- Backend ใช้ decimal คำนวณก่อนปัดผลแสดง ไม่ควรรวมเลขที่ปัดแล้วจากการ์ดเอง

offshoreValuation เป็นยอดรวมเฉพาะหุ้นนอก USD ที่ยังถือ มี source, scope, cacheTtlSeconds, heldPositionCount, pricedPositionCount, missingPriceCount, incompleteCostCount, stalePriceCount, isComplete, oldestPriceAt, newestPriceAt, usd, thb, limitations

usd/thb มี marketValue, remainingCost, unrealizedPnl, unrealizedPnlPercent และ availableMarketValue (ผลรวมเฉพาะหุ้นที่หาราคาได้) ถ้าราคาไม่ครบ marketValue/PnL รวมจะเป็น null ไม่ตีว่าส่วนที่ไม่มีราคามีมูลค่าเป็น 0; availableMarketValue ต้องติดป้ายว่าเป็นยอดบางส่วน

marketValuation.status อาจเป็น CALCULATED, PRICE_UNAVAILABLE, COST_INCOMPLETE, INCOMPLETE, NOT_HELD หรือ UNSUPPORTED หุ้นไทย/กองทุนมี THB valuation แยกแล้ว ดู [คู่มือหุ้นไทยและกองทุน](FRONTEND_THAI_STOCK_AND_FUND_MARKET_GUIDE.md) ไม่อ่าน usd ของสองประเภทนั้น

issues อาจมี MARKET_INSTRUMENT_UNSUPPORTED, PRICE_NOT_AVAILABLE, PRICE_RATE_LIMITED, PRICE_DAILY_LIMIT, PRICE_ACCESS_DENIED, MARKET_DATA_CONFIG_MISSING, COST_BASIS_INCOMPLETE, ZERO_COST_PERCENT_UNDEFINED, STALE_PRICE, STALE_FX_RATE, VALUATION_OUT_OF_RANGE

ข้อจำกัด: เฉพาะ unrealized price PnL ไม่รวม fees/dividends/FX PnL ไม่มีการ reconcile splits หรือ corporate actions จาก confirmation โดยอัตโนมัติ หุ้นไทยใช้ Yahoo Finance และกองทุนใช้ SEC NAV แยกจาก Finnhub ไม่รวมเข้ายอด offshoreValuation

## โลโก้

หลัง restart รายชื่อหุ้นอาจต้องโหลดใหม่ โดยใช้ budget รวม 20 วินาที ส่วน quote/profile แต่ละคำขอยัง 5 วินาที ถ้าโหลดรายชื่อ timeout จะได้ PRICE_CATALOG_TIMEOUT / LOGO_CATALOG_TIMEOUT พร้อม retryAt ให้แสดงสถานะไม่พร้อมและรอ ไม่ถือว่าหุ้นมีมูลค่า 0 รายละเอียดและคำสั่งตรวจจริงอยู่ใน [คู่มือตั้งค่า Finnhub](FINNHUB_SETUP_GUIDE.md)

includeLogos=true จึงจะมี item.logoUrl/item.logo แยกจาก marketValuation ใช้ logoUrl เป็น src พร้อม onerror/fallback ตัวย่อหุ้นเสมอ ไม่ให้ Frontend เรียก Finnhub profile ด้วย key เอง

หุ้นนอก USD ที่ยังถือและรองรับใช้ Finnhub ตามเดิม ถ้าหุ้นรองรับแต่ upstream ไม่มีรูป จะเป็น logoUrl=null พร้อม logo.status=UNAVAILABLE และ errorCode/retryAt ส่วนหุ้นไทย THB ที่ยังถือรองรับ URL รูป SET โดย logo.status=UNVERIFIED ตาม [คู่มือโลโก้หุ้นไทย](FRONTEND_THAI_STOCK_LOGO_GUIDE.md) กองทุน THB ที่ยังถือใช้ SEC/AIMC/Logo.dev ตาม [คู่มือโลโก้กองทุน](FRONTEND_MUTUAL_FUND_LOGO_GUIDE.md) ส่วนรายการขายหมด/สินทรัพย์ที่ไม่รองรับจะเป็น logoUrl=null, logo=null

Backend รับเฉพาะ HTTPS public image URL ของ Finnhub ที่ผ่าน validation ไม่ proxy/download รูป ควรให้ browser ใช้ referrerpolicy=no-referrer; รูปอาจยังโหลดไม่ได้และต้องมี fallback

logo.providerSymbol คือ ticker ใน company profile ของ Finnhub อาจต่างจาก logo.symbol สำหรับ ADR ที่ยืนยันแล้ว เช่น ASML → ASML.AS และ TSM → 2330.TW ใช้ logo.symbol/holdings.symbol เป็นตัวระบุหุ้นในพอร์ตต่อไป ห้ามเปลี่ยน symbol ของพอร์ตหรือสกุลราคาตาม providerSymbol ฟิลด์นี้ใช้บอกที่มารูปเท่านั้น ไม่กระทบ quote/costBasis

## ข่าวรายหุ้น

~~~http
GET /api/v1/trades/stocks/AMD/news?exchange=XNAS&limit=20
~~~

เฉพาะหุ้นนอก USD ที่ผู้ใช้ยังถือ ไม่รับ userId จาก Frontend; exchange ไม่บังคับถ้า symbol ตรงตลาดเดียว ถ้ากำกวมตอบ 400 AMBIGUOUS_STOCK_MARKET ให้ส่ง exchange จาก holdings

limit เป็นจำนวนเต็ม 1–50 default 20 ช่วงข่าวกำหนดโดย Backend เป็น 7 วันปฏิทิน UTC รวมวันนี้ ไม่รับ from/to จาก client สูงสุด 50 ข่าวที่ผ่าน validation ใน cache, hasMore หมายถึงมีมากกว่า limit ใน cache นี้ ไม่ใช่สัญญาว่ามี pagination ไปข่าวทั้งหมด

ตัวอย่าง response (ข้อมูลสมมุติ):

~~~json
{
  "status": "AVAILABLE",
  "source": "FINNHUB",
  "symbol": "AMD",
  "micCode": "XNAS",
  "from": "2026-10-14",
  "to": "2026-10-20",
  "items": [
    {
      "id": "12345",
      "headline": "Example company update",
      "source": "Publisher",
      "publishedAt": "2026-10-20T14:30:00.000Z",
      "url": "https://publisher.example/article",
      "imageUrl": null,
      "summary": "Example short summary",
      "relatedSymbols": ["AMD"]
    }
  ],
  "fetchedAt": "2026-10-20T15:00:00.000Z",
  "expiresAt": "2026-10-20T15:30:00.000Z",
  "fromCache": false,
  "isStale": false,
  "limit": 20,
  "hasMore": false,
  "maxItems": 50,
  "cacheTtlSeconds": 1800
}
~~~

AVAILABLE + items=[] คือไม่มีข่าวในช่วงนี้ ไม่ใช่ error ข่าวแสดงหัวข้อ/สรุป/สำนักข่าว/วันเวลา และลิงก์ไปต้นทาง ไม่มีบทความเต็ม เก็บ source ของสำนักข่าวไว้แสดงด้วย

UNAVAILABLE จะมี items=[], errorCode, retryAt และ from/to แต่ไม่มี fetchedAt/expiresAt หากไม่เคยสำเร็จ ปิดเฉพาะกล่องข่าวได้ ไม่ให้หน้าพอร์ตล้มตาม

ข่าวเป็นข้อมูลภายนอกที่ไม่เชื่อถือ: แสดงเป็น text เท่านั้น ห้ามใช้ innerHTML, ลิงก์ target=_blank ต้อง rel=noopener noreferrer, รูปใช้ fallback และไม่ส่ง token ไปกับ URL รูป/ข่าว

## Cache และความสด

- ราคาช่วงตลาดเปิด cache 15 นาที หลังปิดมี on-demand refresh แล้วเก็บจนเปิดรอบถัดไปตาม calendar; โลโก้ 7 วัน ข่าว 30 นาที public metadata cache ใช้ร่วมกันทุกผู้ใช้ใน process เดียว แยกจากข้อมูล holdings ส่วนตัว ดูรายละเอียดและข้อยกเว้นในคู่มือ session-aware cache
- Finnhub listing catalog ยืนยัน currency/MIC cache 24 ชั่วโมง; XNAS เทียบเฉพาะ Nasdaq family XNAS/XNGS/XNMS/XNCM ตลาดอื่นต้องตรง
- แต่ละ quote อาจมี priceAt ต่างกัน อย่าแสดงว่าเป็นราคาเดียวกัน ณ เวลาปัจจุบันทั้งหมด
- fromCache=true ไม่ได้แปลว่าเก่า ต้องดู isStale, fetchedAt, expiresAt และ priceAt แยกกัน
- isStale สำหรับราคาอ้างอิงนโยบาย cache และสถานะ refresh ไม่ได้รับรองว่าเป็น tick ล่าสุด ตรวจ priceAt ประกอบเสมอ ช่วงปิดตลาด snapshot ที่ใช้ยาวถึงเปิดใหม่อาจมี isStale=false ได้
- ถ้า refresh ไม่สำเร็จจะคืน stale ที่อยู่ในขอบเขต พร้อม warning/retryAt และเวลาเดิม ไม่สร้างราคา 0
- เคารพ retryAt ไม่วนยิงทันที ทั้งราคา/โลโก้/ข่าวรวมงบ 60 calls/นาที (และ cap 30/วินาที) ไม่ใช่แยก endpoint ละ 60
- การเรียกครั้งแรกมี catalog API เพิ่ม 1 call และอาจมี HTTP request ไป static catalog อีก 1 ครั้งผ่าน redirect ที่ตรวจสอบปลายทางแล้ว ทั้งสอง request นับใน budget แอป; signed URL อยู่เฉพาะ Backend ไม่ส่งให้ Frontend ถ้ารายการเยอะเกิน budget บางหุ้นอาจต้องรอรอบถัดไป ไม่มี auto-queue ฝั่ง Backend
- ใช้ stale badge/เวลาข้อมูลอย่างตรงไปตรงมา อย่าแสดงว่า realtime รับประกัน ไม่ควร polling ถี่กว่าความจำเป็น
- 401 ของ Backend เป็น Supabase auth; provider ปฏิเสธเป็นข้อมูลเสริม HTTP 200 พร้อม *_ACCESS_DENIED
- ไม่มี SQL ใหม่; ไม่ต้อง resync/reimport PDF; ไม่ส่ง FINNHUB_API_KEY ไป frontend

ก่อน public production ต้องตรวจสิทธิ์ market data/news/logo และ attribution ให้ตรงรูปแบบแอป ไม่ถือว่า free API key ให้สิทธิ์ redistribute โดยอัตโนมัติ อ้างอิง [Finnhub docs](https://finnhub.io/docs/api) และ [official schema](https://github.com/Finnhub-Stock-API/finnhub-go/blob/master/api/openapi.yaml)
