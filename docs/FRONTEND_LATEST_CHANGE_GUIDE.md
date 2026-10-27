# Frontend: การเปลี่ยนแปลงตามข้อมูลล่าสุด รายตัว/ประเภท/ทั้งพอร์ต

## เรียกใช้

```http
GET /api/v1/trades/holdings?includeMarket=true&includeFx=true
Authorization: Bearer <Supabase access token>
```

เพิ่มฟิลด์เมื่อ includeMarket=true เท่านั้น ไม่มี endpoint/flag ใหม่ ใช้ quote/NAV และ FX snapshot เดิม ไม่เพิ่มคำขอ provider เพื่อ feature นี้ ไม่ต้องเพิ่ม SQL/env หรือ import ใหม่ ไม่แก้ต้นทุน/Realized/Unrealized PnL เดิม Cache แชร์เฉพาะข้อมูล provider การคำนวณตามจำนวนที่ถือทำต่อ request ของผู้ใช้ ไม่แชร์ยอดส่วนตัวข้ามผู้ใช้

ต้องส่ง includeFx=true หากมีหุ้นนอกและต้องการยอดรวมบาทครบ หากไม่ขอ FX หรือ FX ไม่พร้อม หุ้นนอกยังมีผลต่างสกุลเดิมแต่ THB เป็น null และยอดรวมไม่ครบ ส่วนหุ้นไทย/กองทุนยังคำนวณได้ ไม่แอบเรียก FX เมื่อ includeFx=false

## สูตร

```text
currentValue = จำนวนที่ถือปัจจุบัน × ราคาหรือ NAV ล่าสุด
referenceValue = จำนวนที่ถือปัจจุบัน × ราคาปิดหรือ NAV ก่อนหน้า
change = currentValue − referenceValue
changePercent = change ÷ referenceValue × 100
```

หุ้นนอกคำนวณ USD ก่อน แล้วคูณทั้ง currentValue/referenceValue ด้วยเรท USD/THB ล่าสุดตัวเดียวกัน หุ้นไทย/กองทุนใช้ THB โดยตรง รวมประเภท/พอร์ตจากมูลค่าที่คำนวณครบ ไม่เฉลี่ยหรือบวกเปอร์เซ็นต์รายตัว ไม่ใช้ต้นทุน THB ตาม PDF ในสูตรนี้ จึงไม่รวมผลค่าเงินรายวัน

ใช้ decimal arithmetic รวมค่าก่อนปัดเศษ เงินปัด 2 ตำแหน่ง เปอร์เซ็นต์ 4 ตำแหน่ง ผลรวมจึงอาจต่างจากผลบวกตัวเลขรายแถวที่ปัดแล้วเล็กน้อย ตัวอย่างหุ้นนอก 2 หุ้น ล่าสุด $110 ปิดก่อน $100 เรท 34 → ส่วนต่าง +680 บาท หุ้นไทย −10 บาท กองทุน +20 บาท รวม +690 บาท มูลค่าอ้างอิงรวม 7,100 บาท → +9.7183%

## รายตัว: items[].latestChange

```json
{
  "status": "CALCULATED",
  "currentDate": "2026-10-21",
  "previousDate": null,
  "priceAt": "2026-10-21T08:00:00Z",
  "isStale": false,
  "native": {
    "currency": "USD", "currentValue": 220,
    "referenceValue": 200, "change": 20, "changePercent": 10
  },
  "thb": {
    "currency": "THB", "currentValue": 7480,
    "referenceValue": 6800, "change": 680, "changePercent": 10
  },
  "issues": []
}
```

native เป็นยอดตามจำนวนหุ้น/หน่วยที่ถือ ไม่ใช่ราคาต่อหน่วย thb เป็นยอดแปลงสำหรับแสดงบาท ราคาต่อหน่วยยังอยู่ใน marketValuation.quote เดิม ไม่มีการแปลงเปอร์เซ็นต์ตาม FX

status:

- CALCULATED: คำนวณส่วนต่างเป็นบาทได้ ไม่ได้ยืนยันว่าข้อมูลสดหรือเป็นวันเดียวกันทั้งหมด
- FX_UNAVAILABLE: คำนวณสกุลเดิมได้แต่ไม่มีเรทแปลงหุ้นนอก
- INCOMPLETE: ขาดราคาล่าสุด/ค่าก่อนหน้า หรือยอดเกินขอบเขตตัวเลข
- UNSUPPORTED: ประเภท/สกุลเงินไม่รองรับ
- NOT_HELD: quantity ไม่ใช่ finite > 0 เช่นขายหมดหรือยอดติดลบ native/thb เป็น null ไม่รวมยอด

ไม่มีราคาก่อนหน้าที่ใช้ได้ referenceValue/change/changePercent เป็น null ไม่ใช่ 0 ราคาใหม่ที่ยังมีอาจแสดง currentValue ได้ แต่ห้ามใช้ค่านั้นแทนส่วนต่าง หากส่วนต่างจริงเท่าศูนย์ให้แสดง 0% ตามปกติ คำนวณได้แม้ต้นทุนไม่ครบ เพราะสูตรนี้ไม่ใช้ costBasis

currentDate หุ้นนอกอิง America/New_York จาก priceAt หุ้นไทยอิง Asia/Bangkok กองทุนใช้ navDate โดยตรง previousDate หุ้นไทยใช้ previousCloseDate กองทุนใช้ previousNavDate ส่วน Finnhub ไม่ให้วันที่ previous close จึงส่ง null ไม่เดาว่าเป็นเมื่อวาน การใช้วัน New York ไม่ยืนยัน session ของ quote

## ยอดรวม: response.latestChange

```json
{
  "scope": "CURRENT_HELD_POSITIONS_LATEST_REFERENCE_CHANGE",
  "currency": "THB",
  "fxRate": 34,
  "fxRateDate": "2026-10-21",
  "fxDailyEffectIncluded": false,
  "portfolio": {
    "status": "CALCULATED", "currency": "THB", "isComplete": true,
    "heldPositionCount": 3, "calculatedPositionCount": 3,
    "missingPositionCount": 0, "stalePositionCount": 0,
    "currentValue": 7790, "referenceValue": 7100,
    "change": 690, "changePercent": 9.7183,
    "availableTotals": {
      "currency": "THB", "currentValue": 7790,
      "referenceValue": 7100, "change": 690, "changePercent": 9.7183
    },
    "referencePeriods": [
      {"assetType":"OFFSHORE_STOCK","currentDate":"2026-10-21","previousDate":null},
      {"assetType":"THAI_STOCK","currentDate":"2026-10-21","previousDate":"2026-10-20"},
      {"assetType":"MUTUAL_FUND","currentDate":"2026-10-21","previousDate":"2026-10-20"}
    ],
    "mixedReferencePeriods": true,
    "referenceDatesComplete": false,
    "issues": []
  },
  "byAssetType": [],
  "limitations": []
}
```

byAssetType จริงมี 3 แถวเสมอ ระบุ assetType=OFFSHORE_STOCK/THAI_STOCK/MUTUAL_FUND และฟิลด์โครงสร้างเดียวกับ portfolio เลือกด้วย find ตาม assetType ไม่ยึด index ตัวอย่างข้างบนละรายการเหล่านี้เพื่อความสั้น

หากมีรายการที่คำนวณไม่ครบ ยอดหลัก currentValue/referenceValue/change/changePercent ของ summary เป็น null และ isComplete=false ส่วน availableTotals รวมเฉพาะรายการที่คำนวณครบทั้งปัจจุบัน/ก่อนหน้า/เรท ต้องติดป้าย “ข้อมูลบางส่วน” ไม่ใช้แทนยอดครบ และไม่ใช่มูลค่าปัจจุบันทั้งหมดที่หาราคาได้ positionCount นับกลุ่ม holdings ไม่ใช่จำนวน symbol ไม่ซ้ำ เพราะต่างบัญชีก็แยกรายการ

พอร์ต/ประเภทที่ไม่มีส่วนถืออยู่ ส่งยอดเงิน 0, changePercent=null, isComplete=true เพราะไม่มีฐานหารเปอร์เซ็นต์ includeClosed=true ไม่ทำให้รายการปิดกลับมารวม ยอดติดลบไม่ใช่ short-position performance ที่รองรับ หากมีประเภทไม่รองรับแต่ quantity > 0 ยอดรวมพอร์ตจะไม่ครบ ไม่ถือว่าสินทรัพย์นั้นมีค่า 0

## การแสดงผลและข้อจำกัด

- ตั้งชื่อ “การเปลี่ยนแปลงตามข้อมูลล่าสุด” ไม่ใช่รับประกันผลตอบแทนจริงของวันนี้ ใช้จำนวนที่ถือปัจจุบันทั้งสองฝั่ง ไม่ใช่จำนวนที่ถือจริง ณ ปิดวันก่อน ไม่ปรับการซื้อขายระหว่างวัน เงินเข้าออก หรือผลตอบแทนแบบ time-weighted
- ไม่รวมผลค่าเงินรายวัน ค่าธรรมเนียม ภาษี เงินปันผล หรือ cash balance และยังไม่ reconcile corporate actions/splits ทุกกรณี ไม่บวก Realized PnL หรือ Unrealized PnL เข้า change นี้
- ใช้ referencePeriods แสดงวันที่ต่างกัน หาก mixedReferencePeriods=true ให้ระบุว่าอ้างอิงหลายช่วง referenceDatesComplete=false หมายถึงมีวันที่ที่ไม่ทราบ เช่น Finnhub previous close ห้ามเดาว่าตรงกับวันกองทุน
- stalePositionCount/isStale และ issues STALE_QUOTE/STALE_FX_RATE บอกว่าราคาหรือเรทเก่า มีตัวเลขคำนวณได้ก็ยังต้องแสดงป้ายข้อมูลเก่า ดู priceAt/navDate/fetchedAt ใน quote เดิมด้วย
- summary isComplete บอกความครบของตัวเลข ไม่รับประกันความสด ความครบของประวัติ หรือช่วงเวลาที่ตรงกัน
- FX_RATE_UNAVAILABLE, PREVIOUS_VALUE_UNAVAILABLE, LATEST_PRICE_UNAVAILABLE, LATEST_CHANGE_INSTRUMENT_UNSUPPORTED, LATEST_CHANGE_OUT_OF_RANGE เป็น issues ที่ใช้ประกอบสถานะ ไม่ควรเปลี่ยนทั้งหน้าเป็น error เพราะบางรายการคำนวณไม่ได้
