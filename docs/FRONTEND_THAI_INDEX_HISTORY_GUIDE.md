# SET/SET50 ย้อนหลังจาก TradingView สำหรับ Analytics

อัปเดต 27 ตุลาคม 2026

## เรียก endpoint เดิม

```http
GET /api/v1/trades/analytics/performance?category=ALL&range=ALL&benchmarkId=SET
GET /api/v1/trades/analytics/performance?category=ALL&range=1Y&benchmarkId=SET50
GET /api/v1/trades/analytics/win-rate?category=ALL&range=1Y&unit=MONTH
Authorization: Bearer <Supabase access token>
```

category/range/unit/auth ใช้สัญญาเดิมใน [คู่มือ Analytics](FRONTEND_ANALYTICS_GUIDE.md)
สูตร DAILY_TWR_APPROXIMATION, THB, gross ซื้อไม่รวมค่าคอมเป็นฐานวันแรก และช่วงแรกไม่เต็มปฏิทินคงเดิม
ไม่เปลี่ยน holdings, ต้นทุนจาก PDF, กราฟมูลค่าสินทรัพย์ `/portfolio-history` หรือการ import

## แหล่งข้อมูลที่ frontend จะได้รับ

| id | source ใน Analytics history | symbol ใน Analytics | ล่าสุดที่ /market-indices |
|---|---|---|---|
| SP500 | YAHOO_FINANCE | ^GSPC | Yahoo เดิม |
| NASDAQ_COMPOSITE | YAHOO_FINANCE | ^IXIC | Yahoo เดิม |
| SET | TRADINGVIEW | SET:SET | Yahoo ^SET.BK |
| SET50 | TRADINGVIEW | SET:SET50 | Yahoo ^SET50.BK |

ใช้ **id** จับคู่ชื่อการ์ด/ตัวเลือก ไม่ใช้ symbol หรือ source เป็น ID กลาง
performance ส่งใน benchmark; win-rate ส่งใน markets[]
ข้อมูลเป็นดัชนี SET/SET50 จริง ไม่ใช่ TDEX หรือกองทุนตัวแทน
THB ตามอัตลักษณ์ดัชนี ไม่ต้องคูณ FX ซ้ำ ดัชนีสหรัฐยังรวม historical FX ตามเดิม
ไม่เอาค่าล่าสุดหรือ changePercent รายวันมาเติมเส้น historical/Win rate

ตัวอย่างย่อเฉพาะส่วนที่เปลี่ยน ตัวเลขผลตอบแทนเป็นตัวอย่างสมมติ:

```json
{
  "calculationVersion": 2,
  "benchmark": {
    "id": "SET50",
    "name": "SET50 Index",
    "source": "TRADINGVIEW",
    "symbol": "SET:SET50",
    "nativeCurrency": "THB",
    "comparisonCurrency": "THB",
    "returnBasis": "PRICE_RETURN",
    "fxIncluded": false,
    "cumulativeReturnPercent": 1.5,
    "diagnostics": {
      "source": "TRADINGVIEW",
      "providerSymbol": "SET:SET50",
      "resolvedSymbol": "SET_DLY:SET50",
      "currencyBasis": "VERIFIED_INDEX_IDENTITY",
      "timeZone": "Asia/Bangkok",
      "dataDelay": "DELAYED",
      "lastPointMayBeProvisional": true,
      "cacheStatus": "HIT",
      "fromCache": true,
      "isStale": false,
      "errorCode": null,
      "retryAt": null
    }
  }
}
```

- resolvedSymbol SET_DLY คือ delayed feed ไม่อ้าง real-time และไม่เดาว่าล่าช้ากี่นาที
- provider อาจไม่ส่ง currency ใน metadata: backend ใช้ symbol/exchange/type/timezone ที่ตรวจแล้ว
  ผูกกับดัชนี THB คงที่และเปิดเผย currencyBasis=VERIFIED_INDEX_IDENTITY
  ถ้า provider ส่ง currency มา ต้องเป็น THB จึงรับข้อมูล
- fetchedAt/expiresAt/fromCache/isStale เป็นอายุ snapshot; observation date จริงอยู่ใน points/coverage ตามเดิม
- lastPointMayBeProvisional=true หมายถึงแท่งวันปัจจุบันอาจยังไม่จบ ไม่ใช่ยืนยันราคาปิดสุดท้าย
  วันนี้อาจเคลื่อนไหวต่างจากการ์ด latest ของ Yahoo เพราะคนละ feed/เวลา/cache
- ไม่ใช้ volume คำนวณผลตอบแทนดัชนี; volume ที่ไม่มีค่าไม่ได้ทำให้ราคาปิดเป็นศูนย์

## Cache และการดึงข้อมูล

- cache RAM สาธารณะร่วมทุกผู้ใช้ แยก SET/SET50, TTL **6 ชั่วโมง** ตาม historical engine เดิม
- single-flight ต่อดัชนี: ขอช่วงเดียวกันพร้อมกันรอผลชุดเดียว ไม่เปิด websocket ซ้ำตามจำนวนผู้ใช้
- ใช้ ALL ต่อช่วงย่อยได้ ขยายช่วงขอเพิ่มเฉพาะส่วนที่ cache ยังไม่มี
  provider request มี lookback อีก 7 วันเพื่อตรวจฐาน coverage และวันหยุด
- ลงวันที่แท่งตาม Asia/Bangkok เรียงเก่าไปใหม่ ไม่ใช้แท่งอนาคตหรือจุดขัดแย้งวันเดียวกัน
- หาก provider จำกัด history จนไม่ถึงต้นช่วง จะไม่บันทึก coverage ปลอมว่าสำเร็จทั้งช่วง
- สูงสุด 6 การโหลด history ที่ยังไม่อยู่ใน cache ต่อนาทีต่อ backend process
  เป็น **เพดานที่เรากำหนด** ไม่ใช่การรับรอง quota ทางการของ TradingView
- timeout รวมต่อโหลด 25 วินาที; ปิด chart/connection หลังสำเร็จ ล้มเหลว หรือยกเลิก
  WebSocket ใช้ระหว่าง backend กับ provider เท่านั้น ไม่เพิ่ม WebSocket endpoint ให้ frontend
- ไม่ใช้บัญชี TradingView, session cookie หรือ API key เพิ่ม; อ่าน anonymous public feed
- ล้มเหลวเก็บ retry ชั่วคราว 1 นาที; metadata/coverage ไม่ยืนยัน 5 นาที
  backend limit ใช้เวลาจนพ้น rolling minute; ส่ง retryAt จริงให้ frontend รอ
- restart/backend watch reload ทำให้ RAM cache หาย หลาย server instance ยังมี cache/limit แยกกัน
- ไม่เก็บรายการซื้อขาย ผู้ใช้ จำนวนหุ้น หรือต้นทุนใน cache นี้
  คำนวณ Analytics จาก snapshot ของเจ้าของ access token ต่อ request ตามเดิม

## ข้อมูลขาดและ error

TradingView ไม่พร้อมไม่ทำให้ข้อมูลพอร์ตหรือดัชนีอื่นหายทั้ง response
ใช้ HTTP 200 + PARTIAL/INCOMPLETE/null พร้อม diagnostics เช่นเดิม ไม่ fallback ไป ETF หรือ Yahoo latest เงียบ ๆ

| errorCode / reason | ความหมาย |
|---|---|
| HISTORY_COVERAGE_INCOMPLETE | ยืนยันประวัติต้นช่วงไม่ได้/ถูกจำกัดช่วง ไม่ควรวาดเชื่อมข้าม |
| HISTORY_LISTING_UNVERIFIED | อัตลักษณ์ดัชนีไม่ตรงกับ SET/SET50 ไทยที่คาด |
| HISTORY_RESPONSE_INVALID / HISTORY_CONFLICTING_OBSERVATIONS | ราคา/เวลาผิดรูปแบบหรือจุดวันเดียวกันขัดแย้ง |
| HISTORY_NOT_AVAILABLE + PROVIDER_TIMEOUT | โหลดเกินเวลา |
| HISTORY_NOT_AVAILABLE + NETWORK_ERROR | เชื่อมต่อไม่ได้/connection หลุด |
| HISTORY_RATE_LIMITED + BACKEND_PER_MINUTE_LIMIT | ชน budget ที่ backend กำหนดเอง; limitSource=BACKEND |

ไม่สร้าง HTTP 429 ปลอมจาก websocket error: providerStatus อาจ null ถ้าไม่มี HTTP status จริง
Frontend อ่าน source/id จาก response ยอมรับ TRADINGVIEW แสดงข้อผิดพลาดแบบข้อมูลยังไม่พร้อม
และเคารพ retryAt ไม่ขอวน ห้ามแทน null ด้วย 0 หรือเพิ่ม WIN/LOSS ให้ช่วงที่เทียบไม่ได้
PENDING ของสัปดาห์/เดือน/ปีที่ยังไม่จบ และ isPartialPeriod ของช่วงเริ่มลงทุน ยังใช้กติกาเดิม

## สิ่งที่ frontend ต้องปรับ

1. ให้ Analytics รองรับ source=TRADINGVIEW และ symbol SET:SET/SET:SET50
2. คง benchmarkId/id SET/SET50 และ query เดิม ไม่ต้องเรียก TradingView เอง
3. แสดงวันที่อ้างอิง/ป้ายข้อมูล delayed หรือ provisional ตาม metadata
4. ล้าง Analytics cache ของ SET/SET50 และ win-rate ทั้งชุดเมื่อ deploy เปลี่ยน provider ครั้งนี้
   calculationVersion ยังคง 2 เพราะสูตรไม่เปลี่ยน; cache ฝั่ง client ควรแยกตาม contract/provider revision ด้วย
5. การ์ดดัชนีล่าสุดยังใช้ `/market-indices` เหมือนเดิม ไม่เปลี่ยนเป็น TradingView

## ติดตั้งและทดสอบ

เพิ่ม runtime dependency แบบ pin `@mathieuc/tradingview@4.1.0` ใน package.json/package-lock แล้ว
รัน npm install ตามปกติและ restart ไม่ต้องเพิ่ม env/SQL/reimport จาก 021
รุ่น 4 ใช้ maintained API; สคริปต์ทดลอง v3 เดิมใน verification เป็นเพียง diagnostic แยก
ไลบรารีนี้ไม่ใช่ API ทางการของ TradingView จึงไม่มีการรับรอง availability/depth/สิทธิ์เผยแพร่ข้อมูลจากตัวแพ็กเกจ

```bash
npm test
node --use-system-ca --env-file=.env scripts/verification/verify-analytics.cjs
node --use-system-ca scripts/verification/verify-thai-index-history.cjs
```

ทดสอบจริง 27 ต.ค. 2026 ด้วยรายการสมมติ NVDA + ASK + KKP US500-UH-E:
กราฟช่วง 28 ส.ค.–27 ต.ค. ได้ 61 จุด COMPLETE, category ทั้งสาม COMPLETE,
Win rate ทั้งสี่ตลาดเทียบได้ 2 เดือนที่สิ้นสุดแล้วรวมเดือนแรกไม่เต็มช่วง ไม่มี INCOMPLETE ในชุดนี้
เดือนปัจจุบันเป็น PENDING ทั้งสี่ตลาด เรียกซ้ำ/สลับหมวดเพิ่ม HTTP 0 และ TradingView loads 0
โหลด TradingView ครั้งแรก 2 ครั้ง (ดัชนีละหนึ่ง connection)
ผลตอบแทนตัวเลขสมมติไม่ใช่พอร์ตผู้ใช้ และช่วงอื่นยังอาจไม่พร้อมตาม coverage จริง

ทดสอบเพิ่มช่วง 26 ต.ค. 2025–26 ต.ค. 2026: SET และ SET50 ได้ตัวละ 241 วันซื้อขาย
โหลด 1M ก่อนขยายเป็น ALL เทียบกับ ALL ตอน cache ว่างได้ทุกจุดเท่ากัน
เรียกช่วง 1M/3M/ALL ซ้ำไม่เพิ่ม load สคริปต์นี้ไม่ใช้ env/key/ฐานข้อมูล
ชุดทดสอบ backend ทั้งหมดผ่าน 372 รายการ รวม identity, ข้อมูลผิด/ขาด, timeout/cleanup,
budget, cache หลายช่วง/TTL/single-flight และการแยกข้อมูลผู้ใช้

อ้างอิง [TradingView-API data API](https://github.com/Mathieu2301/TradingView-API/blob/main/docs/data-api.md)
และ [low-level API](https://github.com/Mathieu2301/TradingView-API/blob/main/docs/low-level-api.md)
