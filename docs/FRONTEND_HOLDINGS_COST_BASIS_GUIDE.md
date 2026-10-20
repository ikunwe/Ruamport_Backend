# ต้นทุนเฉลี่ยและต้นทุนคงเหลือ (015–016)

ล่าสุด 018: [กองทุนคำนวณ Average Cost จาก totalAmount ที่อ่านจาก PDF ได้แล้ว](FRONTEND_MUTUAL_FUND_AVERAGE_COST_GUIDE.md) ไม่ต้องมี grossAmount ดิบ ข้อจำกัดกองทุนที่ขาด gross ในรุ่นเก่าด้านล่างไม่ใช่เงื่อนไขปัจจุบัน

**ล่าสุด 017:** หุ้นนอก Compressed FIFO, หุ้นไทย FIFO, กองทุน Average Cost ดู [คู่มือวิธีต้นทุนแยกสินทรัพย์](FRONTEND_ASSET_COST_METHODS_GUIDE.md) เนื้อหาและตัวอย่าง 015–016 ด้านล่างอธิบายวิธีในรุ่นก่อนหน้า

**อัปเดต 016:** หุ้นนอกเปลี่ยนเป็น Compressed FIFO ส่วนหุ้นไทย/กองทุนยังใช้วิธีเดิม ดู [คู่มือหุ้นนอก Compressed FIFO](FRONTEND_OFFSHORE_COMPRESSED_FIFO_GUIDE.md) พร้อม metadata ล่าสุด (`costBasisMethod=BY_ASSET_TYPE` และวิธีรายสินทรัพย์/สกุลเงิน) ตัวอย่าง response รุ่น 015 ด้านล่างเก็บไว้เพื่ออธิบายวิธีเดิม ไม่ใช่วิธีหุ้นนอกหลัง 016

## เริ่มใช้งาน

รัน `supabase/migrations/015_holdings_average_cost.sql` หลัง 007–014 แล้วรัน `supabase/migrations/016_offshore_compressed_fifo.sql` ต่อใน Supabase SQL Editor ไม่เพิ่ม table/column ไม่ลบข้อมูล ไม่ต้อง Import ใหม่สำหรับรายการเดิมที่มี gross/date ครบ

ใช้ `GET /api/v1/trades/holdings` พร้อม Bearer token เหมือนเดิม เพิ่ม `items[].costBasis`, `remainingCostTotals`, `stockRemainingCostTotals` โดยคงจำนวนหน่วย ยอดซื้อขาย และค่าธรรมเนียมเดิม

## วิธีคิดและลำดับ

หลัง 016 หุ้นนอกใช้ Compressed FIFO ตามคู่มือใหม่ สูตร moving weighted average ด้านล่างใช้กับหุ้นไทยและประเภทอื่นที่ยังไม่ได้เปลี่ยนวิธี ทั้งสองวิธีแยกกลุ่มตามผู้ใช้ ประเภทสินทรัพย์ บัญชี symbol ตลาด และสกุลเงินเดิมของ holdings ไม่รวมต้นทุนข้ามบัญชี

```text
ซื้อ: ต้นทุนใหม่ = ต้นทุนคงเหลือเดิม + grossAmount ซื้อ
     จำนวนใหม่ = จำนวนเดิม + จำนวนซื้อ
     ต้นทุนเฉลี่ยใหม่ = ต้นทุนใหม่ / จำนวนใหม่

ขาย: ต้นทุนที่ตัดออก = จำนวนขาย × ต้นทุนเฉลี่ยก่อนขาย
     ต้นทุนคงเหลือใหม่ = ต้นทุนเดิม − ต้นทุนที่ตัดออก
     จำนวนใหม่ = จำนวนเดิม − จำนวนขาย
```

สำหรับ moving weighted average การขายไม่เปลี่ยนค่าเฉลี่ยของหน่วยที่เหลือ แต่ Compressed FIFO ของหุ้นนอกอาจเปลี่ยนค่าเฉลี่ยหลังขาย ทั้งสองวิธีไม่ใช้ยอดรับขายลดต้นทุน ไม่ใช้ totalAmount, หน่วย × ราคา หรือยอดสะสมหารหุ้นที่เหลือมาทดแทน gross ที่ขาด ไม่รวมค่าธรรมเนียม VAT ภาษีหัก ณ ที่จ่าย หรือส่วนลด

เรียงตาม `investment_transactions.trade_date` (วันที่คำสั่งมีผล ไม่ใช่ settlement date หรือวันที่ Import) จึงคำนวณใหม่เมื่อ Import เอกสารย้อนหลังได้

ถ้ากลุ่มเดียวกันมีทั้ง BUY และ SELL ในวันเดียวกัน แต่ไม่มีเวลาภายในวัน จะส่ง INCOMPLETE/INTRADAY_ORDER_AMBIGUOUS ไม่เดาลำดับจากเลขคำสั่งหรือชื่อ PDF เพราะลำดับมีผลต่อต้นทุน ส่วนหลาย BUY อย่างเดียวหรือหลาย SELL อย่างเดียวในวันเดียวกันยังคำนวณได้

ขายหมด: remainingCost=0, averageCostPerUnit=null เพราะไม่มีหน่วยเหลือให้เฉลี่ย ซื้อรอบใหม่หลังขายหมดจะเริ่มต้นทุนเฉลี่ยใหม่ ไม่ยกค่าเฉลี่ยของรอบเก่ามาใช้

## ฟิลด์รายสินทรัพย์

`items[].costBasis` เป็น array สกุลเงิน:

| ฟิลด์ | ความหมาย |
| --- | --- |
| `currency` | เช่น USD หรือ THB |
| `averageCostPerUnit` | ต้นทุนเฉลี่ยต่อหุ้น/หน่วย ไม่รวมค่าธรรมเนียม |
| `remainingCost` | ต้นทุนหน่วยที่ยังถือ ไม่ใช่มูลค่าตลาด |
| `rawAverageCostPerUnit` | ค่าเฉลี่ยก่อนปรับยอดแสดงผลเศษหุ้น |
| `rawRemainingCost` | ต้นทุนก่อนปรับยอดแสดงผลเศษหุ้น |
| `quantity` | จำนวนหน่วยแสดงผลของ holdings |
| `roundingAdjusted` | มีการปรับต้นทุนจากเกณฑ์เศษหุ้นหรือไม่ |
| `status` | CALCULATED หรือ INCOMPLETE |
| `issues` | array รหัสข้อจำกัด/สาเหตุ |

หุ้นนอกใช้ grossAmount.foreign สำหรับ USD/สกุลเดิม และ grossAmount.thb สำหรับ THB แยกกันตลอดประวัติ ไม่ใช้เรตวันนี้แปลงต้นทุนย้อนหลัง หุ้นไทยส่ง THB เท่านั้น ไม่สร้าง USD ด้วยเรตสมมุติ

หลัง 018 กองทุนใช้ totalAmount ของคำสั่งซื้อเป็นต้นทุนไม่รวมค่าธรรมเนียม ไม่ต้องมี grossAmount ใน parser แล้ว ถ้าขาดยอดจะส่ง BUY_AMOUNT_REQUIRED ส่วน SWITCH_IN/OUT ยังไม่มีกฎโอนต้นทุน จึงส่ง UNSUPPORTED_COST_TRANSACTION ไม่คาดเดาต้นทุนแทนข้อมูลที่ขาด

## ตัวอย่าง response รุ่น 015 ก่อนเปลี่ยนหุ้นนอก (ตัวอย่างล่าสุดดูคู่มือ 016)

ซื้อ 10 หุ้น gross $100/THB 3,500 ซื้ออีก 10 หุ้น gross $140/THB 5,040 แล้วขาย 5 หุ้นในวันถัดไป:

```json
{
  "costBasisMethod": "MOVING_WEIGHTED_AVERAGE",
  "costBasisSource": "GROSS_AMOUNT_EXCLUDING_FEES",
  "costBasisOrder": "TRADE_DATE_NO_INTRADAY_INFERENCE",
  "costBasisTotalsScope": "ALL_IMPORTED_POSITIONS_INCLUDING_CLOSED",
  "items": [{
    "symbol": "AMD",
    "quantity": 15,
    "costBasis": [
      {
        "currency": "THB", "status": "CALCULATED",
        "averageCostPerUnit": 427, "remainingCost": 6405,
        "rawAverageCostPerUnit": 427, "rawRemainingCost": 6405,
        "quantity": 15, "roundingAdjusted": false, "issues": []
      },
      {
        "currency": "USD", "status": "CALCULATED",
        "averageCostPerUnit": 12, "remainingCost": 180,
        "rawAverageCostPerUnit": 12, "rawRemainingCost": 180,
        "quantity": 15, "roundingAdjusted": false, "issues": []
      }
    ]
  }],
  "remainingCostTotals": [
    {"currency":"THB","remainingCost":6405,"isComplete":true,"positionCount":1,"incompletePositionCount":0},
    {"currency":"USD","remainingCost":180,"isComplete":true,"positionCount":1,"incompletePositionCount":0}
  ],
  "stockRemainingCostTotals": [
    {"currency":"THB","remainingCost":6405,"isComplete":true,"positionCount":1,"incompletePositionCount":0},
    {"currency":"USD","remainingCost":180,"isComplete":true,"positionCount":1,"incompletePositionCount":0}
  ]
}
```

ตัวอย่างมีสินทรัพย์เดียว ถ้ามีหลายตัวจะรวมเฉพาะ remainingCost แยกสกุลเงิน ไม่รวมค่าเฉลี่ยของคนละสินทรัพย์เข้าด้วยกัน

## ยอดรวมและข้อมูลไม่ครบ

- `remainingCostTotals`: รวมทุกกลุ่มสินทรัพย์ที่อยู่ใน holdings รวมกองทุน ถ้ามีกลุ่มคำนวณไม่ได้ในสกุลนั้นจะส่ง remainingCost=null/isComplete=false ไม่คืนยอดรวมบางส่วนที่ดูเหมือนครบ
- `stockRemainingCostTotals`: เหมือนกันแต่เฉพาะหุ้นนอกและหุ้นไทย ไม่ให้กองทุนที่ขาดข้อมูลปะปนกับการ์ดต้นทุนหุ้น
- `positionCount`: จำนวนกลุ่มสินทรัพย์/บัญชีในสกุลนั้น, `incompletePositionCount`: จำนวนกลุ่มที่คำนวณต้นทุนไม่ได้
- ยอดรวมไม่เปลี่ยนเมื่อสลับ includeClosed กลุ่มขายหมดที่คำนวณได้มีต้นทุน 0
- USD รวมเฉพาะกลุ่มที่มี USD ไม่ใช่ทั้งพอร์ตแปลงเป็น USD ห้ามบวก USD กับ THB ของต้นทุนเดียวกัน
- ยังไม่มีราคาตลาด กำไร/ขาดทุน หรือ FX สดเพิ่มในรอบนี้

ถ้าคำนวณไม่ได้ `status="INCOMPLETE"`, `averageCostPerUnit=null`, `remainingCost=null` ไม่ใช่ 0 ทั้งนี้ USD อาจคำนวณได้ขณะที่ THB ขาด gross หรือกลับกัน

| issue | สาเหตุ |
| --- | --- |
| BUY_GROSS_REQUIRED | ขาด gross ซื้อของสกุลเงินนี้ |
| SELL_EXCEEDS_AVAILABLE_UNITS | เคยขายก่อนมีหุ้น หรือขายเกินจำนวนที่มีเกิน tolerance |
| TRADE_DATE_REQUIRED | ไม่มีวันที่เรียงรายการ |
| INTRADAY_ORDER_AMBIGUOUS | มีซื้อและขายวันเดียวกันแต่ไม่มีเวลา |
| UNSUPPORTED_COST_TRANSACTION | มี reward/exercise/switch หรือประเภทที่ยังไม่รองรับต้นทุน |
| ORDER_ID_COLLISION | เลขคำสั่งเดิมมีข้อมูลต่างกันที่ยังต้องตรวจสอบ |
| INVALID_COST_UNITS / INVALID_BUY_GROSS | จำนวนหน่วยไม่เป็นบวก หรือ gross ซื้อผิดรูปแบบ/ติดลบ |
| COST_QUANTITY_MISMATCH | จำนวนที่คำนวณต้นทุนไม่สอดคล้องกับ holdings |
| ROUNDING_CLOSURE_ESTIMATE | CALCULATED แต่มีการปรับตามเกณฑ์เศษหุ้น |

แม้ยอดหุ้นปลายทางเป็นบวก หากเคยขายเกินก่อนมีรายการซื้อ จะยังระบุว่าประวัติไม่ครบ ไม่ใช้การซื้อภายหลังซ่อมต้นทุนย้อนหลังเอง CALCULATED/isComplete=true หมายถึงคำนวณได้จากข้อมูลที่ Import ไม่ได้ยืนยันว่าผู้ใช้ซิงค์ประวัติครบทั้งบัญชี และไม่ใช่หลักฐานต้นทุนทางภาษี

## เศษหุ้นและความละเอียด

ใช้เกณฑ์หุ้นเดิม ±0.0000003 เมื่อ holdings ปิดเศษหุ้นได้และไม่มีรายการพิเศษ/collision ต้นทุนแสดงผลเป็น 0 ค่าเฉลี่ยเป็น null แต่ rawRemainingCost ยังส่งเศษดิบไว้ตรวจสอบ ไม่แก้ transaction เดิม กองทุนไม่ใช้ tolerance หุ้น

กรณีขายเกินเล็กน้อยภายในเกณฑ์แล้วซื้อรอบใหม่ จะเริ่มต้นทุนรอบใหม่จาก 0 ไม่ยกต้นทุนติดลบไปลด gross ซื้อใหม่ หากจำนวนรอบใหม่ต่างจาก holdings เล็กน้อยภายในเกณฑ์ จะปรับต้นทุนแสดงผลให้สอดคล้องกับจำนวน holdings โดยเก็บ rawRemainingCost ไว้และระบุ roundingAdjusted หากส่วนต่างสะสมเกินเกณฑ์จะส่ง COST_QUANTITY_MISMATCH

ใช้ numeric ใน PostgreSQL ไม่ปัดค่าเฉลี่ยก่อนนำไปขาย Frontend ปัดเพื่อแสดงผลได้ แต่ห้ามคำนวณต้นทุนใหม่จากค่าเฉลี่ยที่ปัดแล้ว

```js
const usd = item.costBasis.find(row => row.currency === 'USD');
const thb = item.costBasis.find(row => row.currency === 'THB');
const stockThb = response.stockRemainingCostTotals.find(row => row.currency === 'THB');
// null/undefined ให้แสดง “—” ไม่ใช้ ?? 0
const averageUsd = usd?.averageCostPerUnit;
const remainingThb = thb?.remainingCost;
const allStockRemainingThb = stockThb?.remainingCost;
const needsHistoryCheck = usd?.status === 'INCOMPLETE';
```

## ทดสอบ

- `npm test`: service/repository/HTTP contract โดย mock ฐานข้อมูล
- `test/holdings-average-cost.integration.sql`: สูตร ลำดับ สกุลเงิน เศษหุ้น ข้อมูลไม่ครบ การตัดซ้ำ/แยกผู้ใช้และ RPC บน development DB หลัง 015 ใช้ BEGIN/ROLLBACK
- `verify-investment-sql.cjs`: ตัวเลือกทดสอบ migrations 007–016 และ SQL ทั้งชุดด้วย PGlite ในหน่วยความจำ ไม่อ่าน .env ไม่เชื่อม Supabase จริง ดูวิธีติดตั้งเฉพาะโฟลเดอร์ทดสอบที่ต้นไฟล์ ไม่เพิ่ม dependency runtime ของ Backend
