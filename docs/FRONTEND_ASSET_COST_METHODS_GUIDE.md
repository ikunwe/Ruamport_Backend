# วิธีต้นทุนแยกตามสินทรัพย์ (017)

อัปเดต 018: กองทุนเชื่อม `totalAmount` ที่อ่านจาก PDF เข้าสูตร Average Cost แล้ว ไม่ต้องมี grossAmount ในข้อมูลดิบ ดู [คู่มือกองทุนล่าสุด](FRONTEND_MUTUAL_FUND_AVERAGE_COST_GUIDE.md) วิธีของหุ้นนอกและหุ้นไทยไม่เปลี่ยน

## เริ่มใช้งาน

รัน `supabase/migrations/017_thai_fifo_cost.sql` หลัง 007–016 ใน Supabase SQL Editor ไม่เพิ่ม table/column ไม่เปลี่ยนรายการดิบ ไม่ต้อง Import หรือซิงค์ข้อมูลเดิมใหม่

ใช้ `GET /api/v1/trades/holdings` พร้อม Bearer token เดิม ชื่อและโครงสร้าง costBasis / remainingCostTotals / stockRemainingCostTotals ไม่เปลี่ยน

## วิธีที่ใช้ปัจจุบัน

| assetType | costBasisMethod / costBasis[].method | ข้อความที่แสดง |
| --- | --- | --- |
| OFFSHORE_STOCK | COMPRESSED_FIFO | หุ้นนอก: Compressed FIFO |
| THAI_STOCK | FIFO | หุ้นไทย: FIFO รายล็อต |
| MUTUAL_FUND | MOVING_WEIGHTED_AVERAGE | กองทุน: Average Cost |

Average Cost ของกองทุนในระบบหมายถึง moving weighted average เมื่อซื้อ/SUB เพิ่ม และตัดต้นทุนตามค่าเฉลี่ยก่อนขาย/RED ไม่ได้เปลี่ยนเป็น FIFO และยังไม่รองรับต้นทุนโอนผ่าน SWI/SWO

ทุกวิธีใช้มูลค่าลงทุนไม่รวมค่าธรรมเนียม VAT ภาษีหัก ณ ที่จ่าย หรือส่วนลด หุ้นใช้ grossAmount ส่วนกองทุนหลัง 018 ใช้ totalAmount รายคำสั่งที่ PDF แยกค่าธรรมเนียมไว้แล้ว ไม่หักค่าธรรมเนียมซ้ำ ค่าธรรมเนียมและยอดซื้อขายเดิมใน amounts ยังแยกเหมือนเดิม ไม่เอาเงินรับจากการขายมาหักต้นทุน

หุ้นนอกยังใช้ grossAmount.foreign กับ grossAmount.thb แยกกัน ไม่เพิ่มเรต FX ใหม่ หุ้นไทย/กองทุนยังเป็น THB ตามเอกสาร ไม่สร้าง USD

## หุ้นไทย FIFO รายล็อต

เรียงตาม trade_date ที่อ่านจากวันที่คำสั่งมีผล เก็บแต่ละ BUY เป็นล็อตแยก **ไม่รวมล็อตรายวัน** ตอน SELL ตัดหน่วยจากล็อตซื้อเก่าก่อน แล้วค่อยเลื่อนไปล็อตถัดไป

```text
วันแรก BUY 10 หุ้น gross 100 THB
วันที่สอง BUY 20 หุ้น gross 400 THB
วันที่สาม SELL 5 หุ้น

ต้นทุนที่ขาย = 5 × (100/10) = 50 THB
ต้นทุนคงเหลือ = 500 − 50 = 450 THB
หุ้นเหลือ = 25
ต้นทุนเฉลี่ยของหุ้นที่เหลือ = 450/25 = 18 THB/หุ้น
```

averageCostPerUnit ของ FIFO เป็นค่าเฉลี่ยของล็อตที่ยังถือ ไม่ใช่ค่าเฉลี่ยที่ใช้ตัดทุกการขาย จึงเปลี่ยนได้เมื่อขายล็อตเก่าออก

### กรณีข้อมูลลำดับภายในวันไม่พอ

ระบบยังไม่มีเวลาจับคู่ใน investment_transactions จึงไม่ถือว่า order_id หรือ UUID พิสูจน์ลำดับซื้อขายได้:

- มีทั้ง BUY และ SELL ใน trade_date เดียวกัน: คง INTRADAY_ORDER_AMBIGUOUS ตามกติกาปลอดภัยเดิม
- ซื้อหลายล็อตคนละราคาในวันเดียวกัน และขายบางส่วนจนล็อตวันที่นั้นถูกใช้ไปไม่หมด: FIFO อาจได้หลายผลขึ้นกับล็อตใดมาก่อน ระบบส่ง INCOMPLETE / INTRADAY_BUY_ORDER_AMBIGUOUS ไม่แสดงต้นทุนจากการเรียงเลขคำสั่งโดยเดา
- ถ้าล็อตทั้งวันยังอยู่ครบ หรือถูกขายหมดทั้งวันแล้ว ลำดับภายในวันนั้นไม่เปลี่ยนต้นทุนคงเหลือ จึงคำนวณต่อได้
- ถ้าหลายล็อตวันเดียวกันมีต้นทุนต่อหน่วยเท่ากัน ลำดับไม่เปลี่ยนผล จึงคำนวณได้

ตัวอย่าง: ซื้อวันเดียวกัน 10 หุ้นต้นทุน 100 และ 20 หุ้นต้นทุน 400 แล้วขาย 5 หุ้นวันถัดไป ถ้าไม่ทราบล็อตใดมาก่อน จะไม่สมมุติว่าต้นทุนคงเหลือเป็น 450 หรือ 400 แต่ส่ง null พร้อมรหัสลำดับไม่ชัด ส่วนหุ้นนอกยังรวมล็อตวันเดียวกันตาม Compressed FIFO เหมือนเดิม

## Metadata ที่ส่งให้ Frontend

```json
{
  "costBasisMethod": "BY_ASSET_TYPE",
  "costBasisMethods": {
    "OFFSHORE_STOCK": "COMPRESSED_FIFO",
    "THAI_STOCK": "FIFO",
    "MUTUAL_FUND": "MOVING_WEIGHTED_AVERAGE"
  },
  "costBasisSource": "GROSS_AMOUNT_EXCLUDING_FEES",
  "costBasisGroupingDate": "TRADE_DATE_AS_PARSED"
}
```

หุ้นไทยส่ง `items[].costBasisOrder = "TRADE_DATE_INDIVIDUAL_LOTS"` ส่วนหุ้นนอกยัง TRADE_DATE_DAILY_LOTS และกองทุน TRADE_DATE_NO_INTRADAY_INFERENCE

ตัวอย่างรายการหุ้นไทยบางฟิลด์:

```json
{
  "assetType": "THAI_STOCK",
  "symbol": "EXAMPLE",
  "quantity": 25,
  "costBasisMethod": "FIFO",
  "costBasisOrder": "TRADE_DATE_INDIVIDUAL_LOTS",
  "costBasis": [{
    "currency": "THB",
    "method": "FIFO",
    "status": "CALCULATED",
    "averageCostPerUnit": 18,
    "remainingCost": 450,
    "rawAverageCostPerUnit": 18,
    "rawRemainingCost": 450,
    "quantity": 25,
    "roundingAdjusted": false,
    "issues": []
  }]
}
```

Frontend ควรใช้ mapping ทั้งสามวิธี ห้ามใช้ `method === COMPRESSED_FIFO ? ... : Average Cost` เพราะจะติดป้ายหุ้นไทยผิด:

```js
const methodLabels = {
  COMPRESSED_FIFO: 'Compressed FIFO',
  FIFO: 'FIFO',
  MOVING_WEIGHTED_AVERAGE: 'Average Cost',
};
const methodLabel = methodLabels[item.costBasisMethod] ?? 'ไม่ทราบวิธีต้นทุน';
const thb = item.costBasis.find(row => row.currency === 'THB');
const average = thb?.averageCostPerUnit;
const remaining = thb?.remainingCost;
// null/undefined ให้แสดง “—” ไม่ใช้ ?? 0
```

## ข้อจำกัดเดิมยังอยู่

- หลัง 018 กองทุนใช้ totalAmount รายคำสั่งที่เก็บไว้ ไม่ต้องมี grossAmount แล้ว หากขาด/ผิดรูปแบบจะส่ง BUY_AMOUNT_REQUIRED ไม่ใช้ NAV × units เดาแทน และยังไม่รองรับการโอนต้นทุน switch
- ขายก่อนซื้อ ขายเกิน ประเภทพิเศษ ขาดวันที่ หรือคำสั่ง collision ยังคง null พร้อม issues ไม่บล็อกการ Import
- หุ้นยังใช้เกณฑ์เศษ ±0.0000003 โดยเก็บ rawRemainingCost แยกไว้ กองทุนไม่ใช้เกณฑ์เศษหุ้น
- remainingCostTotals รวมทุกสินทรัพย์ stockRemainingCostTotals รวมเฉพาะหุ้น ยอดรวมคงแยกสกุล ถ้ามีกลุ่มคำนวณไม่ได้ในสกุลหนึ่ง ยอดรวมสกุลนั้นเป็น null/isComplete=false ไม่คืนผลรวมบางส่วนที่ดูเหมือนครบ
- การตัดซ้ำ การแยกผู้ใช้/บัญชี/ตลาด includeClosed และข้อมูลที่อ่านจาก PDF ไม่เปลี่ยน ไม่เพิ่มราคาตลาดหรือ FX สด

## ทดสอบ

`test/holdings-asset-cost-methods.integration.sql` ตรวจสามวิธีผ่าน RPC เดียว และ FIFO รายล็อต ขายบางส่วน/ข้ามล็อต ขายหมด เศษหุ้น ข้อมูลไม่ครบ ลำดับวันเดียวกัน ตัดซ้ำ และแยกผู้ใช้ รันบน development DB หลัง 017 โดยใช้ BEGIN/ROLLBACK หรือ `node verify-investment-sql.cjs tmp/cost-basis-validation` เพื่อรันทดสอบ migrations 007–017 และ SQL ทั้งชุดใน PGlite แบบ in-memory โดยไม่อ่าน .env/เชื่อม Supabase จริง
