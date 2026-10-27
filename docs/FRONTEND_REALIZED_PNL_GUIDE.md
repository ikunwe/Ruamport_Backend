# กำไร/ขาดทุนจากการขายแล้ว ก่อนค่าธรรมเนียม

## เปิดใช้งาน

รัน `supabase/migrations/019_holdings_realized_pnl.sql` ใน Supabase SQL Editor **หลัง 018** ไม่ต้องลบ table หรือ import PDF ใหม่ ไม่มี column/table ใหม่หรือการแก้ transaction เดิม Migration เพิ่ม helper และปรับ get_stock_holdings ให้คำนวณตอนอ่าน ใช้สิทธิ์ service_role เดิม ไม่เปิด RPC ให้ anon/authenticated เรียกตรง

```http
GET /api/v1/trades/holdings?includeClosed=true
Authorization: Bearer <Supabase access token>
```

ไม่มี endpoint/flag ใหม่สำหรับกำไร ใช้ร่วมกับ includeMarket/includeFx/includeLogos เดิมได้ Backend ส่งค่าจาก Database ไม่คำนวณกำไรซ้ำ Frontend ไม่ต้องเรียงรายการหรือใช้ราคาปัจจุบันหากำไรขายแล้ว

## การคำนวณ

```text
soldCost = totalBuyValue − costBasis.remainingCost
realizedPnl = totalSellValue − soldCost
```

ใช้ค่าต้นทุนคงเหลือของกลุ่มสินทรัพย์/บัญชี/ตลาด/สกุลเงินเดียวกัน ตามวิธีเดิม: หุ้นนอก COMPRESSED_FIFO, หุ้นไทย FIFO, กองทุน MOVING_WEIGHTED_AVERAGE หุ้นใช้ grossAmount ไม่รวมค่าธรรมเนียม ส่วนกองทุนใช้ totalAmount รายคำสั่งตาม mapping ของ 018 ซึ่งแยกค่าธรรมเนียมอยู่แล้ว ไม่หักค่าธรรมเนียมซ้ำ

หุ้นนอกคำนวณ USD และ THB ตามยอด PDF แยกกัน ไม่เอากำไร USD คูณเรท Frankfurter ปัจจุบัน หุ้นไทย/กองทุนส่ง THB เท่านั้น ไม่มี USD สร้างขึ้นใหม่ กำไรนี้เป็นยอดสะสมจากรายการ import ทั้งหมด ไม่ใช่แยกการขายแต่ละรอบหรือเฉพาะเดือน และไม่ใช่กำไรจากราคาปัจจุบันของหุ้นที่ยังถือ

ไม่รวมค่าธรรมเนียม VAT ภาษี ส่วนลด เงินปันผล หรือกำไร FX ที่แยกวิเคราะห์ ไม่ใช่รายงานต้นทุน/กำไรทางภาษี

## ฟิลด์ใหม่

ตัวอย่างเฉพาะฟิลด์ที่เพิ่มใน item หุ้นนอกหนึ่งตัว:

```json
{
  "symbol": "AMD",
  "realizedPnl": [
    {
      "currency": "USD",
      "status": "CALCULATED",
      "totalBuyValue": 300,
      "totalSellValue": 80,
      "soldCost": 50,
      "realizedPnl": 30,
      "method": "COMPRESSED_FIFO",
      "source": "PDF_ORDER_GROSS_AMOUNT",
      "feesIncluded": false,
      "taxesIncluded": false,
      "roundingAdjusted": false,
      "issues": []
    },
    {
      "currency": "THB",
      "status": "CALCULATED",
      "totalBuyValue": 10700,
      "totalSellValue": 2880,
      "soldCost": 1750,
      "realizedPnl": 1130,
      "method": "COMPRESSED_FIFO",
      "source": "PDF_ORDER_GROSS_AMOUNT",
      "feesIncluded": false,
      "taxesIncluded": false,
      "roundingAdjusted": false,
      "issues": []
    }
  ]
}
```

- เลือก currency ด้วย find ไม่ยึดลำดับ array
- soldCost เป็นต้นทุนของหน่วยที่ขายแล้ว ไม่ใช่ยอดขายหรือ remainingCost
- realizedPnl > 0 คือกำไร, < 0 คือขาดทุน, = 0 คือเท่าทุน/ยังไม่มีรายการขายเมื่อข้อมูลคำนวณครบ
- status=INCOMPLETE จะส่ง soldCost/realizedPnl=null อย่าใช้ `?? 0` แสดง “ข้อมูลไม่ครบ” หรือ —
- totalBuyValue/totalSellValue อาจยังมีค่าขณะที่กำไรเป็น null แต่ไม่ควรคำนวณเองเพื่อข้ามสถานะ
- issues รับต่อจากต้นทุน เช่น ORDER_ID_COLLISION, INTRADAY_ORDER_AMBIGUOUS, SELL_EXCEEDS_AVAILABLE_UNITS และเพิ่ม BUY_VALUE_REQUIRED/SELL_VALUE_REQUIRED เมื่อยอดหายหรือผิดรูปแบบ/ติดลบ ปัญหา USD ไม่จำเป็นต้องทำให้ THB คำนวณไม่ได้ และกลับกัน
- roundingAdjusted/ROUNDING_CLOSURE_ESTIMATE หมายถึงใช้ต้นทุนคงเหลือที่ปรับเศษเพื่อแสดงผลตามเกณฑ์หุ้นเดิม กำไรจึงเป็นค่าประมาณตามเกณฑ์นั้น ยอดดิบยังอยู่ใน costBasis.rawRemainingCost และ transaction เดิม ไม่ใช้ tolerance หุ้นกับกองทุน

## ยอดรวม

ระดับ response เพิ่ม realizedPnlTotals (ทุกสินทรัพย์) และ stockRealizedPnlTotals (เฉพาะหุ้นนอก/หุ้นไทย) แยก currency รูปแบบแต่ละแถว:

```json
{
  "currency": "USD",
  "soldCost": 100,
  "realizedPnl": -20,
  "isComplete": true,
  "positionCount": 1,
  "incompletePositionCount": 0,
  "feesIncluded": false,
  "taxesIncluded": false
}
```

ยอดรวมรวมกลุ่มที่ขายหมดแล้วเสมอ แม้ไม่ส่ง includeClosed=true ดังนั้นอาจไม่เท่าผลรวม items ที่แสดงอยู่ ต้องขอ includeClosed=true หากต้องการแสดงรายละเอียดของหุ้นขายหมดด้วย หากมีข้อมูลคำนวณไม่ได้ในสกุลใด ยอดรวมสกุลนั้นเป็น null/isComplete=false ไม่แอบแสดงยอดบางส่วนเป็นยอดครบ พอร์ตว่างส่ง []

metadata: realizedPnlSource=HISTORICAL_PDF_VALUES_MINUS_DISPOSED_COST, realizedPnlTotalsScope=ALL_IMPORTED_POSITIONS_INCLUDING_CLOSED และ realizedPnlLimitations ระบุข้อจำกัด source รายแถวของกองทุนคือ PDF_ORDER_TOTAL_AMOUNT_EXCLUDING_FEES

includeFx=true ไม่แปลง realizedPnl นี้ไปอยู่ใน displayThb: ใช้แถว THB ของ realizedPnl สำหรับกำไรตาม PDF ต่อไป อย่านำ USD มาแปลงรวมกับ THB เดิมหรือรวมยอดคนละสกุล

CALCULATED หมายถึงคำนวณได้จากประวัติที่ import ไม่ได้ยืนยันว่าประวัติครบทั้งบัญชี รายการซ้ำที่ระบบทำเครื่องหมายแล้วไม่ถูกรวม รายการพิเศษ/สับเปลี่ยนที่วิธีต้นทุนไม่รองรับยังให้ INCOMPLETE ตามเดิม ไม่เดาต้นทุน

## ทดสอบสำหรับผู้พัฒนา

`npm test` ตรวจ HTTP contract ส่วน `node scripts/verification/verify-investment-sql.cjs tmp/cost-basis-validation` ใช้ PostgreSQL-compatible PGlite แยกใน memory ตรวจ migrations และ SQL fixtures ไม่มี production credentials ทุก SQL fixture rollback ไม่ได้รัน migration บน Supabase จริงโดยอัตโนมัติ
