# กองทุน: ต้นทุนเฉลี่ยต่อหน่วยและต้นทุนคงเหลือ (018)

## เปิดใช้งาน

รัน `supabase/migrations/018_mutual_fund_average_cost.sql` หลัง migrations 007–017 ใน Supabase SQL Editor ไม่เพิ่ม table/column ไม่ลบรายการ ไม่แก้ข้อมูลดิบ/preview/order_signature และไม่ต้องซิงค์หรือ Import เอกสารเก่าใหม่

ใช้ `GET /api/v1/trades/holdings` พร้อม Bearer token เหมือนเดิม กองทุน MUTUAL_FUND จะคำนวณต้นทุน Average Cost จากข้อมูลที่อ่านและเก็บอยู่แล้ว หุ้นนอก Compressed FIFO และหุ้นไทย FIFO ไม่เปลี่ยน

## แหล่งเงินลงทุน: totalAmount ของรายการกองทุน

PDF กองทุนแสดงคอลัมน์จำนวนเงินรวม (Total Amount) กับค่าธรรมเนียมรวม VAT แยกกัน ระบบอ่านเป็น `totalAmount` และ `feeIncludeVat` อยู่แล้ว รอบนี้เชื่อม totalAmount ของคำสั่งซื้อเข้า Average Cost โดยไม่ต้องเพิ่ม grossAmount ลงในข้อมูลดิบ

**ใช้ `investment_transactions.details.totalAmount` ของ SUBSCRIPTION เป็นต้นทุนซื้อ ไม่หัก feeIncludeVat ออกอีก และไม่บวกค่าธรรมเนียม/VAT/ภาษีหรือส่วนลดเข้าไป** ไม่ใช้ summary ทั้งเอกสารแทนรายการ และไม่ใช้ units × navPerUnit คำนวณยอดเงินทับ PDF

ตัวอย่าง: totalAmount=1,500 THB และ feeIncludeVat=4 THB => ต้นทุนซื้อที่ใช้คือ **1,500** ไม่ใช่ 1,496 หรือ 1,504

เป็นการ normalize เฉพาะตอนอ่านเพื่อคำนวณ ไม่เปลี่ยน parser หรือเพิ่ม derived fields ลง details จึงไม่กระทบการเทียบ signature เพื่อตัดคำสั่งซ้ำข้าม PDF ข้อมูลเก่าที่ไม่มี grossAmount แต่มี totalAmount จึงคำนวณได้ทันทีหลังรัน 018

## สูตร Average Cost

เรียงตาม trade_date (วันที่คำสั่งมีผลที่อ่านได้) ไม่ใช่วันซิงค์หรือวันชำระราคา แยกตามผู้ใช้ บัญชี และชื่อกองทุน/share class เหมือน holdings เดิม

```text
SUBSCRIPTION:
  ต้นทุนคงเหลือใหม่ = ต้นทุนเดิม + totalAmount ซื้อใหม่
  จำนวนหน่วยใหม่ = จำนวนเดิม + units ซื้อใหม่
  ต้นทุนเฉลี่ยต่อหน่วยใหม่ = ต้นทุนคงเหลือใหม่ / จำนวนหน่วยใหม่

REDEMPTION:
  ต้นทุนที่ตัดออก = units ขาย × ต้นทุนเฉลี่ยก่อนขาย
  ต้นทุนคงเหลือใหม่ = ต้นทุนเดิม − ต้นทุนที่ตัดออก
  จำนวนหน่วยใหม่ = จำนวนเดิม − units ขาย
```

ใช้ต้นทุนเฉลี่ยแบบเคลื่อนไหว MOVING_WEIGHTED_AVERAGE ไม่ใช่ FIFO ไม่ใช้ยอดรับขาย/ราคาขายมาหักต้นทุน การขายบางส่วนไม่เปลี่ยนค่าเฉลี่ยของหน่วยที่เหลือ ขายหมด => remainingCost=0 และ averageCostPerUnit=null ซื้อรอบใหม่หลังขายหมดเริ่มต้นทุนใหม่

## Frontend ใช้ค่าตรงไหน

ในรายการ `item.assetType === 'MUTUAL_FUND'` เลือก `item.costBasis.find(row => row.currency === 'THB')`:

| สิ่งที่แสดง | ฟิลด์ |
| --- | --- |
| จำนวนหน่วยคงเหลือ | item.quantity |
| ต้นทุนเฉลี่ยต่อหน่วย | costBasis แถว THB: averageCostPerUnit |
| ต้นทุนรวมคงเหลือ | costBasis แถว THB: remainingCost |
| วิธีคิด | item.costBasisMethod หรือแถว method = MOVING_WEIGHTED_AVERAGE |
| ข้อมูลพร้อมคำนวณ | แถว status = CALCULATED |
| สาเหตุที่ข้อมูลไม่ครบ | แถว issues |
| แหล่งยอดเงิน | แถว source หรือ item.costBasisSource = PDF_ORDER_TOTAL_AMOUNT_EXCLUDING_FEES |
| รวมค่าธรรมเนียมหรือไม่ | แถว feesIncluded = false |

`amounts[].totalBuy` เป็นยอดซื้อสะสม ไม่ใช่ต้นทุนคงเหลือหลังขาย `navPerUnit` / `unit_price` เป็น NAV ของรายการแต่ละรอบ ไม่ใช่ต้นทุนเฉลี่ยของหน่วยที่เหลือ

หุ้นไทย/กองทุนยังไม่มี USD แปลงให้ใหม่ กองทุนส่งเฉพาะ THB ไม่มีเรตสดเพิ่ม

## ตัวอย่าง JSON บางส่วน

ซื้อ 10 หน่วยด้วยมูลค่า 100 บาท ซื้อเพิ่ม 10 หน่วยด้วยมูลค่า 140 บาท แล้วขาย 5 หน่วยในวันถัดไป ไม่ว่าจะได้เงินขายเท่าใด จะได้:

```json
{
  "assetType": "MUTUAL_FUND",
  "fundName": "EXAMPLE-FUND",
  "quantity": 15,
  "costBasisMethod": "MOVING_WEIGHTED_AVERAGE",
  "costBasisSource": "PDF_ORDER_TOTAL_AMOUNT_EXCLUDING_FEES",
  "costBasis": [{
    "currency": "THB",
    "method": "MOVING_WEIGHTED_AVERAGE",
    "source": "PDF_ORDER_TOTAL_AMOUNT_EXCLUDING_FEES",
    "feesIncluded": false,
    "status": "CALCULATED",
    "averageCostPerUnit": 12,
    "remainingCost": 180,
    "rawAverageCostPerUnit": 12,
    "rawRemainingCost": 180,
    "quantity": 15,
    "roundingAdjusted": false,
    "issues": []
  }]
}
```

```js
const cost = item.costBasis.find(row => row.currency === 'THB');
const averageCostPerUnit = cost?.averageCostPerUnit;
const remainingCost = cost?.remainingCost;
const needsReview = cost?.status === 'INCOMPLETE';
// แสดง null/undefined เป็น “—” หรือ “ข้อมูลต้นทุนไม่ครบ” ห้ามใช้ ?? 0
```

ระบบใช้ numeric ของ PostgreSQL ไม่ปัดค่าเฉลี่ยระหว่างซื้อขาย Frontend ปัดเพื่อแสดงผลได้ แต่ไม่ควรใช้ค่าเฉลี่ยที่ปัดแล้วคำนวณต้นทุนใหม่ ส่วนต่างเล็กน้อยจาก navPerUnit ของคำสั่งอาจเกิดจากจำนวนหน่วย/จำนวนเงินที่เอกสารปัดไว้ เพราะต้นทุนเฉลี่ยคิดจากมูลค่ารวม ÷ หน่วย ไม่ใช้ NAV มาทับมูลค่ารวม

## ยอดรวมและ metadata

- `remainingCostTotals` รวมต้นทุนคงเหลือทุกสินทรัพย์แยกสกุลเงิน รวมกองทุนด้วย หลัง 018 กองทุนที่มี totalAmount ครบจะไม่ทำให้ยอดรวมเป็น null เพียงเพราะไม่มี grossAmount แล้ว
- `stockRemainingCostTotals` ยังรวมเฉพาะหุ้น ไม่มีกองทุนปะปน
- ยอดรวมรวม CLOSED เหมือนเดิม ไม่เปลี่ยนเมื่อสลับ includeClosed; กลุ่มขายหมดที่คำนวณได้มีต้นทุน 0
- ถ้ามีกลุ่มใดคำนวณไม่ได้ ยอดรวมสกุลนั้นยังเป็น null/isComplete=false ไม่ส่งยอดรวมบางส่วนที่ดูเหมือนครบ
- Top-level `costBasisSources` เพิ่ม mapping: OFFSHORE_STOCK/THAI_STOCK = PDF_ORDER_GROSS_AMOUNT, MUTUAL_FUND = PDF_ORDER_TOTAL_AMOUNT_EXCLUDING_FEES
- Top-level costBasisSource=GROSS_AMOUNT_EXCLUDING_FEES เป็นนโยบายต้นทุนไม่รวมค่าธรรมเนียมเดิม ส่วนชื่อฟิลด์ต้นทางจริงให้ดู costBasisSources/item.costBasisSource/แถว source
- `amounts[].totalBuyGross` / totalSellGross เดิมยังสะท้อน grossAmount ดิบตาม 014 จึงอาจเป็น null สำหรับกองทุนได้ **อย่าใช้ช่องนั้นแทน costBasis** รอบนี้ไม่ได้เปลี่ยนยอดซื้อขาย/gross/ค่าธรรมเนียมใน amounts

## ข้อมูลไม่ครบและข้อจำกัดที่ยังคงอยู่

| issue | ความหมายสำหรับกองทุน |
| --- | --- |
| BUY_AMOUNT_REQUIRED | ขาด totalAmount ซื้อ หรือเป็นรูปแบบที่ใช้ไม่ได้ ไม่มีการใช้ NAV หรือ gross อื่นเดาแทน |
| INVALID_BUY_AMOUNT | totalAmount ซื้อเป็นค่าติดลบ |
| COST_CURRENCY_UNSUPPORTED | ข้อมูลกองทุนไม่ใช่ THB จึงไม่ติดป้ายเป็น THB หรือแปลงเอง |
| SELL_EXCEEDS_AVAILABLE_UNITS | เคยขายก่อนมีหน่วย หรือขายเกินจำนวนที่เก็บอยู่ |
| TRADE_DATE_REQUIRED | ขาดวันที่เรียงคำสั่ง |
| INTRADAY_ORDER_AMBIGUOUS | มีทั้งซื้อและขายวันเดียวกัน แต่ไม่มี execution time เพื่อตัดสินลำดับ |
| UNSUPPORTED_COST_TRANSACTION | มี SWITCH_IN/OUT หรือประเภทที่ยังไม่มีกฎโอนต้นทุน |
| ORDER_ID_COLLISION | คำสั่งเดิมมีข้อมูลต่างกันที่ยังต้องตรวจสอบ |
| INVALID_COST_UNITS / COST_QUANTITY_MISMATCH | หน่วยไม่ถูกต้องหรือยอดไม่สอดคล้องกับ holdings |

ยังไม่กำหนดวิธีโอนต้นทุนข้ามกองทุนเมื่อสับเปลี่ยน จึงไม่ถือว่า SWI เป็นซื้อด้วยเงินใหม่หรือ SWO เป็นขายโดยเดา แต่จำนวนหน่วยถือครองและยอดสับเปลี่ยนยังแสดงตามระบบเดิม

กองทุนไม่ใช้เกณฑ์ปิดเศษหุ้น ±0.0000003 จึงคงเศษหน่วยเล็ก ๆ และต้นทุนของเศษนั้น ไม่ตั้งเป็น 0 อัตโนมัติ CALCULATED หมายถึงคำนวณจากประวัติที่ Import แล้ว ไม่ยืนยันว่าซิงค์ครบทั้งบัญชี และไม่ใช่มูลค่าตลาดหรือข้อมูลต้นทุนทางภาษี

คำเตือนรวมยอด PDF ไม่ตรงยังไม่บล็อก Import และสูตรยังใช้ totalAmount รายคำสั่งที่อ่านได้ ไม่คำนวณยอดใหม่ทับเพื่อบังคับให้ตรง NAV/summary

## ทดสอบ

- `npm test`: service/repository/HTTP response source/fee exclusion/null handling
- `test/holdings-mutual-fund-average-cost.integration.sql`: ซื้อเพิ่ม ขายบางส่วน ขายหมด เปิดรอบใหม่ เศษหน่วย สกุลเงิน ข้อมูลไม่ครบ mapping totalAmount ของข้อมูลเก่า การตัดซ้ำ และยืนยันว่ารายการดิบไม่เปลี่ยน (development DB หลัง 018, BEGIN/ROLLBACK)
- `node scripts/verification/verify-investment-sql.cjs tmp/cost-basis-validation`: migrations 007–018 และ SQL 9 ชุดบน PGlite ในหน่วยความจำ ไม่ใช้ .env/ข้อมูลฐานจริง
