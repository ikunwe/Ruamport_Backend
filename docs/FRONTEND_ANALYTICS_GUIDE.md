# Analytics: ผลตอบแทนพอร์ต เทียบดัชนี และ Win rate

อัปเดต 27 ตุลาคม 2026 สำหรับ `ANALYTICS_BACKEND_REQUIREMENTS.md` ข้อ 1–3

## การเปลี่ยนแปลง: นับตั้งแต่ซื้อวันแรก (calculationVersion 2)

Performance และ Win rate รวมผลตอบแทนวันแรกแล้ว โดยใช้ยอดซื้อจริงก่อนค่าธรรมเนียมเป็นฐาน
ช่วงแรกของ WEEK/MONTH/YEAR เริ่มจากวันลงทุนจริง ไม่ต้องรอให้ครบช่วงปฏิทิน
ส่ง `calculationVersion: 2` ทั้งสอง endpoint; frontend ต้องล้าง Analytics cache ของวิธีเดิม
และใช้ version นี้ใน cache key ไม่เอาเส้น/Win rate เก่ามารวมกับผลรอบใหม่
ไม่ต้องรัน SQL เพิ่มจาก 021 หรือ import ใหม่ เพียง restart backend

## เริ่มใช้

1. รัน `supabase/migrations/021_analytics_orders.sql` ใน Supabase SQL Editor **หลัง 020**
2. Restart Backend ใช้ key provider เดิม ไม่เพิ่ม env หรือ import PDF ใหม่
3. เรียก endpoint ด้านล่างพร้อม `Authorization: Bearer <Supabase access token>`

021 เพิ่ม read-only RPC `get_analytics_orders(uuid)` สำหรับ service role เท่านั้น ดึงจากรายการ
IMPORTED ที่ไม่ซ้ำของเจ้าของ access token พร้อม `flowAmount` ก่อนค่าธรรมเนียม
ไม่เปลี่ยนตาราง ข้อมูล PDF ต้นทุน FIFO/Average Cost หรือ RPC ของกราฟมูลค่าเดิม
Frontend ไม่เรียก RPC/provider โดยตรง ไม่ส่ง userId

## Endpoint และตัวเลือก

```http
GET /api/v1/trades/analytics/performance?category=ALL&range=1Y&benchmarkId=SP500
GET /api/v1/trades/analytics/win-rate?category=ALL&range=1Y&unit=MONTH
```

| Query | ค่าที่รับ | Default |
|---|---|---|
| category | ALL, OFFSHORE_STOCK, THAI_STOCK, MUTUAL_FUND | ALL |
| range | 1M, 3M, 1Y, ALL | 1Y |
| benchmarkId (performance) | SP500, NASDAQ_COMPOSITE, SET, SET50 | SP500 |
| unit (win-rate) | WEEK, MONTH, YEAR | MONTH |

ค่าผิดหรือ query ซ้ำจนเป็น array ได้ HTTP 400; ไม่รองรับ Dow Jones ใน Analytics รอบนี้
`win-rate` ส่งทั้ง 4 ตลาดในครั้งเดียว จับคู่ด้วย id ไม่ใช้ตำแหน่ง array
ทั้งสอง endpoint เป็น private HTTP `Cache-Control: no-store` และตรวจ auth เดิม

## วิธีคำนวณที่ใช้งานจริง

`portfolio.method = DAILY_TWR_APPROXIMATION` เป็นผลตอบแทนประมาณจากราคาปิด/NAV รายวัน
ปรับเงินจากการซื้อขาย ไม่ใช่ exact intraday TWR และไม่ใช่ผลตอบแทนบัญชี Dime รวมเงินสด

- Replay รายการทุกตัวที่เคยถือ รวมตัวที่ขายหมดแล้ว ใช้ engine กราฟเดิมซึ่งรองรับ split/reverse split
  และการยืนยันตลาดปัจจุบันเฉพาะกราฟ ไม่แก้ PDF
- มูลค่าสินทรัพย์วัน t คือผลรวมจำนวนที่ถือสิ้นวัน × ราคาวันนั้น; หุ้นนอกคูณ USD/THB ของวันนั้น
- กระแสเงิน F_t = ยอดซื้อ gross − ยอดขาย gross ไม่ใช้ราคาขายสุทธิหลังหักค่าคอม
- หุ้นนอกใช้ PDF `grossAmount.foreign` คูณ FX ของวัน tradeDate; หุ้นไทยใช้ `grossAmount`;
  กองทุนใช้ `totalAmount` ที่แยกจากค่าธรรมเนียมตาม parser/ต้นทุนเดิม
- เมื่อมูลค่าวันก่อน V_(t−1) > 0:

```text
dailyFactor_t = (V_t − F_t) / V_(t−1)
dailyReturnPercent = (dailyFactor_t − 1) × 100
cumulativeReturnPercent = (ผลคูณ dailyFactor ที่รวมอยู่ในช่วง − 1) × 100
```

สมมติเงินเข้าออกปลายวัน (`END_OF_DAY_ASSUMPTION`) จึงอาจต่างจากผลตอบแทนจริงระหว่างวัน
โดยเฉพาะวันที่ซื้อขายมาก หาก factor ติดลบหรือคำนวณไม่ได้ ส่ง null พร้อม issue ไม่ฝืนให้เป็นเปอร์เซ็นต์

เมื่อขายหมด วันขายยังคำนวณได้จาก gross ขาย เงินที่ขายไม่ถูกถือเป็นเงินสดลงทุนต่อ
วันที่พอร์ตว่างและไม่มี flow ใช้ factor 1 แต่ช่วงที่ไม่มีทุนตลอดจะไม่ถูกนับ Win rate
เมื่อทุนวันก่อนเป็นศูนย์และมีเฉพาะซื้อ ใช้ `V_t / grossBuy_t` โดยสมมติเงินซื้อเข้าต้นวัน
(`zeroCapitalEntryTiming = BEGINNING_OF_DAY_GROSS_BUYS`); หากซื้อและขายจากทุนศูนย์วันเดียวกัน
หรือยืนยันตัวหารไม่ได้ ส่ง `ANALYTICS_ZERO_CAPITAL_DENOMINATOR`

วันแรกที่เริ่มลงทุนรวม gross ซื้อทั้งหมดของวันนั้นเป็นทุน (`FIRST_DAY_GROSS_BUYS`)
สมมติทุนเข้าต้นวัน เช่นซื้อจริง 1,000 บาท ก่อนค่าคอม และมูลค่าสิ้นวัน 1,020 บาท:
firstDayFactor = 1,020 / 1,000 = 1.02 จึงได้ dailyReturnPercent และ portfolioReturnPercent วันแรก 2%
ไม่บังคับจุดแรกเป็น 0% ไม่หักค่าคอมเพิ่มหรือรวม totalAmount สุทธิของหุ้นเข้าเป็นทุน
หุ้นนอกแปลง gross USD ด้วย historical FX ของวันซื้อ และรวมกับสินทรัพย์ THB
ไม่ใช้ยอดต้นทุนสะสมปัจจุบัน/ต้นทุนเฉลี่ย/FIFO เป็นฐานวันแรก
หากวันแรกซื้อและขายผสมกันจนใช้สมมติฐานต้นวันไม่ได้ จะส่ง INCOMPLETE ไม่เดายอดทุน

สำหรับช่วงย่อยที่วันเริ่มช่วงอยู่หลังวันลงทุนแรกแล้ว ยังคงใช้มูลค่าปิดวันเริ่มช่วงเป็นฐาน 0%
(`portfolio.baselineBasis = DAILY_CLOSE`) ไม่เอากำไรวันเริ่มลงทุนเก่ามาบวกซ้ำ
ถ้าช่วงที่เลือกครอบคลุมวันเริ่มลงทุน ใช้ `portfolio.baselineBasis = FIRST_DAY_GROSS_BUYS`
และส่ง `portfolio.initialCapitalThb` เป็นทุนวันแรกที่ใช้จริง; แบบ DAILY_CLOSE ส่ง null
ไม่ใช้ผลสะสม ALL แทนช่วงย่อย
ไม่รวมค่าธรรมเนียม ภาษี ปันผล/เงินสดที่ไม่มีรายการ; NAV กองทุนอาจรวมค่าใช้จ่ายกองทุนอยู่แล้ว
ไม่ได้อ้างว่าเป็น total return หรือรายงาน GIPS
หลักการ geometric linking และข้อจำกัด daily cash-flow approximation อ้างอิง
[GIPS Handbook](https://www.gipsstandards.org/standards/gips-standards-for-firms/gips-standards-handbook-for-firms/)

### สับเปลี่ยนกองทุน

SWITCH_IN/OUT ภายใน ALL หรือ MUTUAL_FUND จะไม่นับเป็นเงินภายนอกสองครั้ง
รอบนี้รับเฉพาะกรณีมีทั้งสองขา **วันเดียวกันและยอดรวมตรงกันพอดี** แล้วใช้ flow 0
ไม่มีการเดาคู่ข้ามวันหรือสร้างเงินสดค้างระหว่างสับเปลี่ยน
หากขาขาด/ยอดต่างกัน วันนั้นเป็น `ANALYTICS_SWITCH_FLOW_UNMATCHED`; ผลสะสมหลังช่องว่างเป็น null
ต้องใช้ข้อมูล settlement/transfer เพิ่มหากต้องการรองรับกรณีข้ามวันในอนาคต

## ช่วงวัน ฐาน และการขาดข้อมูล

- วันจบเป็นวันนี้ `Asia/Bangkok`; 1M/3M/1Y ย้อน 30/90/365 วัน รวมวันต้นและปลาย
- ALL เริ่มวัน tradeDate แรกของหมวดที่เลือก ไม่ใช่วันเริ่มถือปัจจุบัน
- ส่ง `requestedStartDate/requestedEndDate`, `startDate/endDate`, `baselineDate` และ `coverage`
- วันก่อนหมวดเริ่มลงทุนไม่มีผลตอบแทน (null, NO_INVESTED_CAPITAL) และแสดงใน coverage
- ใช้ baseline แรกที่มีทุนจริงได้เฉพาะหลังวันที่ยืนยันว่าไม่มีทุน ไม่ข้าม missing valuation เพื่อสร้างฐานใหม่
- หุ้น/ดัชนี/FX ใช้ observation ล่าสุดที่ไม่เกินวันนั้น และอายุ **น้อยกว่า 7 วันปฏิทิน**;
  NAV น้อยกว่า 14 วัน ตาม engine เดิม ไม่ใช้ราคาจากอนาคต
- แต่ละจุดส่ง `portfolioObservations.oldestPriceDate/newestPriceDate/carriedPositionCount`,
  `benchmarkObservationDate`, `fxRateDate`, `benchmarkFxRateDate`
- ถ้าระหว่างช่วงข้อมูลขาด เส้นผลสะสมฝั่งนั้นเป็น null ต่อไป ไม่เชื่อมข้าม/ไม่ rebase เงียบ ๆ
  อีกฝั่งที่ข้อมูลครบยังส่งได้ ต้องเรียกใหม่เมื่อข้อมูลเติมครบ
- จุดวันนี้อาจเป็นราคาระหว่างวัน/NAV คนละวัน จึงมี limitation LAST_POINT_MAY_BE_PROVISIONAL
  ไม่อ้างว่าตลาดทุกแห่งปิดพร้อมกัน

## Performance response ที่ frontend ใช้

| Field | ใช้ทำอะไร |
|---|---|
| portfolio.cumulativeReturnPercent | การ์ดผลตอบแทนพอร์ตของช่วง |
| benchmark.cumulativeReturnPercent | การ์ดผลตอบแทนตลาดของช่วง |
| points[].portfolioReturnPercent / benchmarkReturnPercent | เส้นสะสมรายวัน ใช้เปอร์เซ็นต์ที่ backend คิดแล้ว |
| points[].dailyReturnPercent | ผลช่วงวันนั้น; วันลงทุนแรกมีผลตอบแทนด้วย ส่วนจุดฐาน DAILY_CLOSE ของช่วงย่อยเป็น null |
| points[].marketValueThb / externalFlowThb | มูลค่าและ flow สำหรับตรวจสอบ ไม่ใช่ต้นทุนหรือกำไรขายแล้ว |
| spreadPercentagePoints | ผลพอร์ตลบผลตลาด หน่วยจุดเปอร์เซ็นต์ |
| comparable | ใช้สรุปชนะตลาดทั้งช่วงได้เมื่อ true |
| comparisonStartDate/endDate | ช่วงที่เทียบได้จริง; end เป็น null หากเทียบไม่ครบ |
| benchmark.coverage | วัน observation แรก/สุดท้ายและจำนวนวันที่ provider ส่งจริง |
| benchmark.diagnostics / diagnostics[] | errorCode, reason, providerStatus, limitSource, retryAt, cacheStatus |

ดัชนีใช้ daily close แบบ PRICE_RETURN: S&P 500/Nasdaq ใช้ Yahoo (^GSPC/^IXIC)
ส่วน SET/SET50 ใช้ TradingView (SET:SET/SET:SET50) เฉพาะข้อมูลย้อนหลัง
ดู [รายละเอียด TradingView และการปรับ frontend](FRONTEND_THAI_INDEX_HISTORY_GUIDE.md)
ค่าล่าสุดที่ `/trades/market-indices` ยังคงใช้ Yahoo และ symbol เดิม
ดัชนีสหรัฐแปลงระดับดัชนี USD เป็น THB ด้วยเรทของแต่ละวันก่อนหาผลตอบแทน
ฐาน THB จึงรวมผล FX ทั้งหุ้นนอกและดัชนีสหรัฐ ไม่เอาเปอร์เซ็นต์ native USD มาเทียบเป็นฐานเดียวกัน
เมื่อเริ่มจากวันลงทุนแรก ดัชนีใช้ observation ล่าสุดที่ไม่เกิน **วันก่อนเริ่มลงทุน** เป็นฐาน
วันหยุด carry ตามขอบเขตเดิม เช่นซื้อวันจันทร์ ใช้ราคาปิดศุกร์หากยังไม่เกินอายุที่กำหนด
ใช้ผลดัชนีตั้งแต่วันลงทุนแรกถึงวันปลายเดียวกับพอร์ต ไม่ใช้วันลงทุนแรกเป็น 0% ของดัชนี
`baselineDate` จึงเป็นวันปฏิทินก่อนลงทุน ส่วน `comparisonStartDate/startDate` คือวันที่เริ่มลงทุนจริง
`benchmark.baselineObservationDate` ระบุวันราคาจริงซึ่งอาจก่อน baselineDate ถ้าเป็นวันหยุด
พอร์ตไม่มีราคาหรือทุนสิ้นวันก่อนลงทุน: ใช้ gross ต้นวัน ไม่สร้าง portfolio observation ปลอมย้อนหลัง
ผล FX วันแรกของ benchmark ใช้เรทก่อนลงทุนถึงสิ้นวัน ส่วนทุนพอร์ต USD ใช้เรทวันซื้อ
นี่เป็นสมมติฐานรายวัน ไม่ได้ยืนยันการซื้อดัชนี ณ นาทีเดียวกับคำสั่งหุ้น
สำหรับช่วงย่อย DAILY_CLOSE ดัชนีและพอร์ตยังใช้ราคาปิดที่ baselineDate เดียวกันตามเดิม

`8.42` คือ 8.42% ไม่คูณ 100 ซ้ำ; 8.42 − 6.75 = 1.67 จุดเปอร์เซ็นต์
ผลสะสมปัด 6 ตำแหน่ง ตัวเลขการ์ดตรงกับจุดปลายเส้น ห้ามใช้ `(มูลค่าปลาย−ต้น)/ต้น` แทน

## Win rate และตารางช่วง

- WEEK จันทร์–อาทิตย์; MONTH/YEAR ปฏิทิน ตาม Asia/Bangkok
- เลือกช่วงปฏิทินที่วันจบอยู่ภายในช่วงร้องขอ พร้อมช่วงปัจจุบันเพื่อแสดง PENDING
  ส่ง `periodSelection = CALENDAR_PERIODS_WITH_INCEPTION_STUB_PLUS_CURRENT_PENDING`
  ไม่สร้างแถวก่อนเริ่มลงทุนของหมวดนั้น
- ช่วงแรกเริ่มที่ firstTradeDate ของหมวดที่เลือก ถึงวันอาทิตย์/สิ้นเดือน/สิ้นปี
  ไม่แปลงผลช่วงสั้นให้เป็นผลตอบแทนเต็มปี และนับช่วงแรกนี้ใน Win rate เมื่อจบช่วงและข้อมูลครบ
  ส่วนช่วงถัดไปใช้ขอบเขตปฏิทินตามปกติ
- วันเริ่มเดือนอาจก่อนขอบเขตกราฟ เช่นเลือก 1M วันที่ 26 ต.ค. ส่งเดือน ก.ย. เต็มด้วย
  ต้องมี baseline 31 ส.ค. และข้อมูลทุกวัน ก.ย. มิฉะนั้น INCOMPLETE
- แต่ละช่วงใช้ **วันก่อน startDate เป็น baselineDate** สำหรับดัชนีและสำหรับราคาปิดพอร์ตช่วงปกติ
  ช่วงเริ่มลงทุนยกเว้นฐานพอร์ต: ใช้ gross ของวันแรก ไม่ต้องมีมูลค่าพอร์ตก่อนลงทุน
  รวม firstDayFactor ในผลคูณเหมือนกราฟ ALL จึงนับผลตั้งแต่การซื้อวันแรก
- รวม dailyFactor ของวันในช่วงทั้งหมด; benchmark คิดจาก baseline/end เดียวกันและตรวจ coverage ทุกวัน
- ถ้า endDate >= วันนี้ ให้ PENDING แม้วันนี้เป็นสิ้นเดือน เพราะจุดปัจจุบันยัง provisional
- ข้อมูลขาด/ไม่มี baseline/ไม่มีทุนตลอดเป็น INCOMPLETE ทั้ง PENDING/INCOMPLETE ไม่นับตัวหาร
- ปัดเปอร์เซ็นต์สองฝั่งเป็น 2 ตำแหน่งแบบ decimal half-away-from-zero ก่อนตัดสิน WIN/LOSS/TIE
  ส่งค่าที่ใช้ตัดสินใน `outcomePortfolioReturnPercent/outcomeBenchmarkReturnPercent`
- wins + losses + ties = comparedPeriodCount; winRatePercent = wins / comparedPeriodCount × 100
  ถ้าไม่มีช่วงเทียบได้ส่ง null แม้ยังมีการ์ดทั้งสี่ตลาด

แต่ละ market ส่ง identity, wins/losses/ties/pendingCount/incompleteCount/comparedPeriodCount,
winRatePercent, periods[], coverage, diagnostics
แต่ละ period ส่ง startDate/endDate/baselineDate, ผลตอบแทนสองฝั่ง, spreadPercentagePoints,
outcome, isComplete, comparable, issues, วันที่ baseline/end ของราคาและ FX
สรุปนับจาก periods ทั้งหมด ไม่มี pagination ที่ทำให้การ์ดกับตารางนับคนละชุด

### Field สำหรับป้ายช่วงแรก

| Field ใน periods[] | ความหมาย |
|---|---|
| calendarStartDate / calendarEndDate | ขอบเขตสัปดาห์/เดือน/ปีตามปฏิทิน |
| startDate / endDate | ขอบเขตคำนวณจริง เริ่มจากวันลงทุนเมื่อเป็นช่วงแรก |
| isFirstInvestmentPeriod | ช่วงนี้มีวันเริ่มลงทุนของหมวดนั้น |
| isPartialPeriod | startDate หลัง calendarStartDate; แสดง “ช่วงแรกไม่เต็มสัปดาห์/เดือน/ปี” |
| periodStartReason | FIRST_INVESTMENT หรือ CALENDAR_BOUNDARY |
| baselineBasis | FIRST_DAY_GROSS_BUYS หรือ PREVIOUS_DAY_CLOSE |
| initialCapitalThb | ทุน gross วันแรกของช่วงเริ่มลงทุน; ช่วงปกติเป็น null |

isPartialPeriod **ไม่ได้แปลว่าข้อมูลขาด** ช่วงไม่เต็มปฏิทินอาจ isComplete/comparable เป็น true และนับ WIN ได้
หากเริ่มตรงวันแรกของปฏิทิน isFirstInvestmentPeriod=true แต่ isPartialPeriod=false
ใช้ startDate/endDate แสดงช่วงจริง อย่าใช้ calendarStartDate ไปสร้างวันก่อนลงทุนเอง
ตัวอย่างเริ่มลงทุนกลางปี ย่อเฉพาะ field ที่ frontend ใช้ (ตัวเลขสมมติ):

```json
{
  "startDate": "2025-08-15", "endDate": "2025-12-31",
  "calendarStartDate": "2025-01-01", "calendarEndDate": "2025-12-31",
  "baselineDate": "2025-08-14",
  "isFirstInvestmentPeriod": true, "isPartialPeriod": true,
  "periodStartReason": "FIRST_INVESTMENT", "baselineBasis": "FIRST_DAY_GROSS_BUYS",
  "initialCapitalThb": 1000,
  "portfolioReturnPercent": 2, "benchmarkReturnPercent": 1,
  "spreadPercentagePoints": 1, "outcome": "WIN", "isComplete": true, "comparable": true
}
```

ปีที่เริ่มลงทุนยังไม่จบจะเป็น PENDING เช่นเดิม ไม่ตีว่าเป็น INCOMPLETE เพียงเพราะเริ่มกลางปี
หาก gross/ราคา/NAV/FX วันแรกหรือฐานดัชนีขาดจริง ยังคงส่ง null/INCOMPLETE ไม่เลื่อนเริ่มให้เอง
วันก่อนลงทุนใน portfolioObservations เป็น null ตามจริง ไม่ใช่ missing baseline สำหรับช่วง inception

## สถานะและตัวอย่าง

HTTP 200 สำหรับข้อมูลบางส่วนหรือ provider ไม่พร้อม; HTTP 401 เมื่อยังไม่ login,
400 query ผิด, 422 เมื่อเกินขอบเขต/วัน tradeDate ไม่พร้อม,
503 `INVESTMENT_STORAGE_UNAVAILABLE` หรือ `ANALYTICS_STORAGE_UNAVAILABLE` เมื่อ storage/RPC ยังไม่พร้อม

ตัวอย่างด้านล่างย่อเฉพาะ field สำคัญ ไม่ใช่ response เต็มหรือผลของผู้ใช้จริง:

```json
{
  "status": "COMPLETE", "isComplete": true, "comparable": true,
  "portfolio": {"method": "DAILY_TWR_APPROXIMATION", "cumulativeReturnPercent": 8.42},
  "benchmark": {"id": "SP500", "returnBasis": "PRICE_RETURN", "cumulativeReturnPercent": 6.75},
  "spreadPercentagePoints": 1.67
}
```

```json
{
  "status": "PARTIAL", "isComplete": false, "comparable": false,
  "portfolio": {"cumulativeReturnPercent": 8.42},
  "benchmark": {"id": "SET", "cumulativeReturnPercent": null},
  "spreadPercentagePoints": null,
  "issues": ["HISTORICAL_OBSERVATION_MISSING", "BENCHMARK_CHAIN_INCOMPLETE"]
}
```

พอร์ตขาดราคา/FX จะแสดง portfolioReturnPercent เป็น null พร้อม issue จาก history เช่น
HISTORICAL_PRICE_MISSING, HISTORICAL_FX_MISSING หรือ HISTORY_FX_NOT_AVAILABLE;
ตลาดที่ข้อมูลยังครบอาจส่ง benchmarkReturnPercent ได้ สถานะเป็น PARTIAL/INCOMPLETE

```json
{
  "status": "EMPTY", "isComplete": false, "comparable": false,
  "baselineDate": null, "points": [],
  "portfolio": {"cumulativeReturnPercent": null},
  "benchmark": {"cumulativeReturnPercent": null},
  "spreadPercentagePoints": null
}
```

```json
{
  "status": "PARTIAL", "comparable": false,
  "benchmark": {
    "id": "SP500", "cumulativeReturnPercent": null,
    "diagnostics": {
      "errorCode": "HISTORY_RATE_LIMITED", "limitSource": "PROVIDER", "providerStatus": 429,
      "reason": "PROVIDER_RATE_LIMIT", "retryAt": "2026-10-26T16:11:00.000Z"
    }
  },
  "retryAt": "2026-10-26T16:11:00.000Z"
}
```

diagnostics.limitSource BACKEND คือ queue/budget ของเรา; PROVIDER คือ upstream
อย่า retry วนก่อน retryAt และอย่าล้างเส้นพอร์ตที่พร้อมเพราะดัชนีตัวเดียวเสีย
Frontend ต้องรักษา null/ช่องว่าง ใช้ป้ายสถานะ ห้ามเติม mock/ศูนย์ลงข้อมูลจริง
Win rate ไม่มีตัวหารต้องแสดงยังเทียบไม่ได้ ไม่ใช่ 0% หรือแพ้ตลาด

## Cache และการโหลด

ราคาหุ้น/NAV/FX/ดัชนีเป็น public process-RAM cache ร่วมผู้ใช้ พร้อม single-flight และรวมช่วง
TTL ประวัติ 6 ชั่วโมง ALL ใช้ต่อช่วงย่อยได้ ขอเพิ่มเฉพาะช่วงที่ขาด
Analytics reuse market instance เดียวกับกราฟเดิม ดัชนีแยก namespace จากหุ้นและราคาปัจจุบัน
Provider budget/negative cache/retry เดิมยังทำงาน ไม่มี background polling

รอบนี้อ่านรายการของเจ้าของและ replay ใหม่ต่อ request ไม่ cache พอร์ตส่วนบุคคลบน backend
จึงเห็น import ล่าสุดโดยไม่ค้าง private cache; ไม่มีการเก็บยอดของผู้ใช้ใน public cache
เพื่อให้ช่วงเต็ม/เปลี่ยน range ใช้ข้อมูลเดียวกัน การคำนวณเตรียมประวัติตั้งแต่เริ่มลงทุนของหมวดนั้น
จึงอาจโหลดนานรอบแรก และใช้ข้อจำกัดเดิมสูงสุด 20,000 orders / 30 instruments / 3,650 daily intervals

ส่ง `cache.scope`, `privateResponseCached:false`, `cacheTtlSeconds`, `expiresAt`, `fromCache`, `isStale`
fromCache บอก public observations ไม่ได้แปลว่าดึง private response ของรอบเก่า
calculatedAt คือเวลาคำนวณ ไม่ใช่เวลา observation ราคา/NAV/FX
Frontend เก็บผลใน state/service แยก user/category/range/benchmarkId หรือ unit ได้
ต้องล้างเมื่อ logout/เปลี่ยนผู้ใช้/import สำเร็จ/แก้หรือลบรายการ/เปลี่ยนวันไทย/manual refresh/เปลี่ยน calculationVersion
อย่าตัดกราฟ ALL เปอร์เซ็นต์มาใช้ช่วงย่อยตรง ๆ เพราะต้อง rebase และคำนวณ period ใหม่ ใช้ endpoint ให้ backend ทำ

## ผลทดสอบ provider จริงและข้อจำกัดที่ยังมี

26 ต.ค. 2026: ทดสอบรายการสมมติ NVDA + ASK + KKP US500-UH-E โดยไม่เข้าฐานข้อมูลจริง
Yahoo หุ้น, SEC NAV, Frankfurter และดัชนีสหรัฐตอบข้อมูลได้ ผลตอบแทนสินทรัพย์ทั้งสามหมวดคำนวณได้
เรียกซ้ำ/เปลี่ยนหมวดหลัง ALL ไม่เพิ่ม provider requests ในชุดทดสอบ

27 ต.ค. 2026: เปลี่ยนเฉพาะ history SET/SET50 จาก Yahoo ที่ให้ข้อมูลวันเดียวมาใช้ TradingView
ทดสอบกราฟผสมสามสินทรัพย์ช่วง 28 ส.ค.–27 ต.ค. ได้ 61 จุด COMPLETE
Win rate ทั้งสี่ตลาดเปรียบเทียบได้ 2 ช่วงที่สิ้นสุดแล้ว (รวมช่วงแรกไม่เต็มเดือน)
และยังมีเดือนปัจจุบัน PENDING ตามเดิม เรียกซ้ำ/เปลี่ยนหมวดไม่เพิ่ม HTTP หรือ TradingView load
ไม่ใช้ ETF แทนดัชนี ไม่อ่านข้อมูลผู้ใช้จริง หาก upstream ขาดข้อมูลในช่วงอื่นยังส่ง null/INCOMPLETE
TradingView anonymous feed อาจ delayed/จำกัด history และแท่งวันนี้ยัง provisional
ค่าล่าสุดจาก Yahoo, สูตรผลตอบแทน/ช่วงแรก และ calculationVersion 2 คงเดิม

## ตรวจสอบซ้ำ

```bash
npm test
node scripts/verification/verify-investment-sql.cjs tmp/cost-basis-validation
node --use-system-ca --env-file=.env scripts/verification/verify-analytics.cjs
```

SQL verifier ใช้ PGlite ในหน่วยความจำ ไม่ apply migration บน Supabase
Live verifier ใช้พอร์ตสมมติและ provider จริง ไม่มีการอ่าน/เขียนข้อมูลผู้ใช้
ผลตัวเลขล่าสุดอาจต่างกันระหว่างรันเพราะจุดปัจจุบันยังเคลื่อนไหว
