# หุ้นนอก: Compressed FIFO (migration 016)

**อัปเดต 017:** หุ้นไทยเปลี่ยนเป็น FIFO รายล็อตแล้ว กองทุนคง Average Cost (MOVING_WEIGHTED_AVERAGE) ดู [คู่มือวิธีต้นทุนปัจจุบัน](FRONTEND_ASSET_COST_METHODS_GUIDE.md) ส่วนสูตรหุ้นนอกในเอกสารนี้ไม่เปลี่ยน ตัวอย่าง mapping หุ้นไทยด้านล่างเป็นรุ่น 016 ก่อนเปลี่ยน

## เปิดใช้งาน

รัน `supabase/migrations/016_offshore_compressed_fifo.sql` ใน Supabase SQL Editor หลัง migrations 007–015 ตามลำดับ ไม่เพิ่ม table/column ไม่ลบ/เขียนทับรายการลงทุน ไม่ต้องซิงค์หรือ Import PDF เดิมใหม่

ใช้ `GET /api/v1/trades/holdings` พร้อม Bearer token เหมือนเดิม คำนวณตอนเรียก endpoint จากรายการ IMPORTED ของผู้ใช้ที่ล็อกอิน โดยไม่นับ is_duplicate=true

เปลี่ยนเฉพาะ OFFSHORE_STOCK จาก MOVING_WEIGHTED_AVERAGE เป็น COMPRESSED_FIFO ส่วน THAI_STOCK และ MUTUAL_FUND ใช้วิธีเดิมทั้งหมด การอ่าน PDF การเก็บ grossAmount การตัดซ้ำ ยอดจำนวนหุ้น และค่าธรรมเนียมไม่เปลี่ยน

## วิธีคิด

อ้างอิงแนวทาง [ต้นทุนหุ้นสหรัฐฯ ของ Dime](https://dime.co.th/th/articles/compressed-fifo-dime): รวมรายการซื้อในวันเดียวกันเป็นล็อตเดียวก่อนตัดล็อตวันเก่าก่อน

กลุ่มแยกตาม user/type/account/symbol/exchange/currency เหมือน holdings เดิม ไม่รวมข้ามบัญชี/ตลาด จากนั้น:

1. เรียงตาม `investment_transactions.trade_date` ที่ parser อ่านจากวันที่คำสั่งมีผล ไม่ใช้วันที่ชำระราคา วันที่ส่งเมล หรือวันที่ Import
2. รวมหน่วย BUY และ grossAmount ของแต่ละวันเป็นล็อตซื้อรายวัน ต้นทุนต่อหน่วยของล็อต = ผลรวม gross ÷ ผลรวมหน่วย ไม่ใช่ค่าเฉลี่ยราคาต่อหุ้นแบบไม่ถ่วงน้ำหนัก
3. เมื่อ SELL ตัดจำนวนจากล็อตวันเก่าที่สุดก่อน ถ้าล็อตนั้นหมดแล้วจึงไปล็อตวันถัดไป
4. ต้นทุนคงเหลือ = ผลรวมต้นทุนส่วนที่ยังเหลือในล็อตต่าง ๆ
5. averageCostPerUnit = ต้นทุนคงเหลือ ÷ หุ้นคงเหลือ ไม่ใช่ moving average ที่ใช้ตัดทุกการขาย

ไม่ปัดต้นทุนเฉลี่ยรายวันก่อนตัดล็อต ใช้ numeric ของ PostgreSQL ตลอดการคำนวณ การขายอาจเปลี่ยนค่าเฉลี่ยของหุ้นที่เหลือได้ ต่างจาก moving weighted average

### แหล่งยอดเงินไม่เปลี่ยน

- USD/สกุลเดิมของหุ้นนอกใช้ `details.grossAmount.foreign`
- THB ใช้ `details.grossAmount.thb` แยกคิวต้นทุนในสกุลนี้ ไม่ใช้เรตสดแปลง USD เป็น THB
- ใช้หน่วยหุ้นและ trade_date ที่เก็บไว้แล้ว ไม่มีการอ่าน PDF ใหม่หรือคำนวณ gross ทับด้วย price × units
- ไม่รวมค่าคอม VAT ภาษีหัก ณ ที่จ่าย หรือส่วนลด และไม่ใช้ totalAmount แทน gross
- ราคาขาย/gross ขาย/เงินรับสุทธิไม่มีผลต่อการตัดต้นทุน FIFO ใช้จำนวนหุ้นที่ขายเท่านั้น
- ถ้าขาด gross ซื้อในสกุลหนึ่ง จะส่งต้นทุนสกุลนั้นเป็น null/INCOMPLETE ไม่ดึงอีกสกุลมาแปลงแทน

## ฟิลด์ที่ Frontend ต้องปรับ

ชื่อและความหมายของ `items[].costBasis[].averageCostPerUnit`, `remainingCost`, raw values, status, issues, roundingAdjusted, remainingCostTotals และ stockRemainingCostTotals ยังเหมือนเดิม เปลี่ยนเฉพาะวิธีคำนวณของหุ้นนอก

**อย่าล็อกข้อความหรือ enum ว่าทั้งพอร์ตเป็น MOVING_WEIGHTED_AVERAGE** หลัง 016 response ใช้:

```json
{
  "costBasisMethod": "BY_ASSET_TYPE",
  "costBasisMethods": {
    "OFFSHORE_STOCK": "COMPRESSED_FIFO",
    "THAI_STOCK": "MOVING_WEIGHTED_AVERAGE",
    "MUTUAL_FUND": "MOVING_WEIGHTED_AVERAGE"
  },
  "costBasisGroupingDate": "TRADE_DATE_AS_PARSED",
  "costBasisSource": "GROSS_AMOUNT_EXCLUDING_FEES"
}
```

รายละเอียดรายสินทรัพย์:

- `items[].costBasisMethod`: วิธีของสินทรัพย์นั้น COMPRESSED_FIFO หรือ MOVING_WEIGHTED_AVERAGE
- `items[].costBasisOrder`: หุ้นนอก TRADE_DATE_DAILY_LOTS; ประเภทอื่น TRADE_DATE_NO_INTRADAY_INFERENCE
- `items[].costBasis[].method`: วิธีของแถวต้นทุนสกุลเงินนั้น เหมือน item.costBasisMethod
- Top-level `costBasisOrder` ยังคง TRADE_DATE_NO_INTRADAY_INFERENCE เพื่อบอกว่าไม่เดาลำดับภายในวัน ส่วนการรวมล็อตให้ดู costBasisGroupingDate และ item.costBasisOrder

## ตัวอย่างที่แยก Compressed FIFO ออกจากอีกสองวิธีได้

```text
วันที่ 1: BUY 10 หุ้น gross USD 100 / THB 3,500
วันที่ 1: BUY 20 หุ้น gross USD 400 / THB 14,000
         => ล็อตวันแรก 30 หุ้น ต้นทุน USD 500 / THB 17,500
วันที่ 2: BUY 10 หุ้น gross USD 300 / THB 10,800
วันที่ 3: SELL 6 หุ้น => ตัดจากล็อตวันแรก

หุ้นเหลือ 34
USD ต้นทุนเหลือ = 800 − (500 × 6/30) = 700
THB ต้นทุนเหลือ = 28,300 − (17,500 × 6/30) = 24,800
```

ถ้าใช้ FIFO ปกติจะเหลือ USD 740 ถ้า moving weighted average จะเหลือ USD 680 แต่ผลใหม่หุ้นนอกต้องเป็น USD 700

ตัวอย่าง response บางฟิลด์ (ตัวเลขเฉลี่ยตัดเพื่อแสดงตัวอย่างเท่านั้น ไม่ใช่กฎปัดของระบบ):

```json
{
  "items": [{
    "assetType": "OFFSHORE_STOCK",
    "symbol": "EXAMPLE",
    "quantity": 34,
    "costBasisMethod": "COMPRESSED_FIFO",
    "costBasisOrder": "TRADE_DATE_DAILY_LOTS",
    "costBasis": [
      {
        "currency": "THB", "method": "COMPRESSED_FIFO", "status": "CALCULATED",
        "averageCostPerUnit": 729.4117647059, "remainingCost": 24800,
        "rawAverageCostPerUnit": 729.4117647059, "rawRemainingCost": 24800,
        "quantity": 34, "roundingAdjusted": false, "issues": []
      },
      {
        "currency": "USD", "method": "COMPRESSED_FIFO", "status": "CALCULATED",
        "averageCostPerUnit": 20.5882352941, "remainingCost": 700,
        "rawAverageCostPerUnit": 20.5882352941, "rawRemainingCost": 700,
        "quantity": 34, "roundingAdjusted": false, "issues": []
      }
    ]
  }]
}
```

```js
const method = item.costBasisMethod;
const label = method === 'COMPRESSED_FIFO'
  ? 'ต้นทุนแบบ Compressed FIFO (ไม่รวมค่าธรรมเนียม)'
  : 'ต้นทุนเฉลี่ยถ่วงน้ำหนัก (ไม่รวมค่าธรรมเนียม)';
const usd = item.costBasis.find(row => row.currency === 'USD');
const averageUsd = usd?.averageCostPerUnit;
const remainingUsd = usd?.remainingCost;
// null/undefined แสดง “—” ไม่ใช้ ?? 0
```

ไม่ต้องให้ Frontend คิดล็อตเองหรือโหลด transactions ทุกหน้ามารวมใหม่ ใช้ costBasis จาก endpoint เดิม ยอดรวมยังใช้ remainingCostTotals / stockRemainingCostTotals แยกสกุล ไม่ sum ค่าเฉลี่ยต่อหุ้นของคนละตัว และไม่บวก USD กับ THB ของต้นทุนเดียวกัน

## สิ่งที่ยังคงเดิมและข้อจำกัด

- ตัวเลขซื้อขาย/gross/ค่าธรรมเนียมใน amounts, moneyTotals, stockMoneyTotals ไม่เปลี่ยน ใช้สูตรใหม่เฉพาะ costBasis และยอดรวม remaining cost
- includeClosed=false ซ่อนรายการขายหมดจาก items เท่านั้น ยอดรวมยังคำนวณครบทุกสถานะ
- ข้อมูลไม่ครบ/ขายเกิน/คำสั่ง collision/รายการพิเศษที่ไม่รองรับ ยังส่ง INCOMPLETE และ null ไม่คาดเดาต้นทุนหรือบล็อก Import
- เกณฑ์เศษหุ้น ±0.0000003 ยังคงเดิม เมื่อปรับปิดสถานะ ต้นทุนแสดงผลเป็น 0/เฉลี่ย null แต่ rawRemainingCost เก็บเศษดิบไว้ใน response
- กองทุนไม่เปลี่ยนเป็น FIFO หลัง 018 ใช้ totalAmount แทน gross ที่ไม่มีใน parser เพื่อคำนวณ Average Cost ได้แล้ว ส่วนการโอนต้นทุน switch ยังไม่รองรับ ดูคู่มือกองทุนล่าสุด
- หากมีทั้ง BUY และ SELL ของกลุ่มเดียวกันใน trade_date เดียว ยังส่ง INTRADAY_ORDER_AMBIGUOUS ตาม safety policy เดิม ไม่สมมุติว่าซื้อก่อนขาย เพราะข้อมูลไม่มี execution time และเอกสารวิธีคิดรายวันอย่างเดียวไม่ยืนยันกฎกรณีนี้
- ใช้ trade_date ตามที่อ่านได้ ไม่แปลงเป็นวันตาม timezone ของรูปมือถือหรืออนุมานวันตลาดใหม่ จึงไม่รับประกันว่าตรง Dime ทุกบาทหากข้อมูลวัน/หน่วย/gross/ประวัติไม่ครบหรือปัดเศษต่างกัน
- ไม่เพิ่ม FX สด มูลค่าตลาด กำไรขาดทุน หรือการคำนวณภาษี

## ทดสอบ

- `npm test`: service/repository/HTTP contract และ metadata แบบแยกสินทรัพย์
- `test/holdings-compressed-fifo.integration.sql`: แยก FIFO ปกติ/เฉลี่ย/Compressed FIFO ด้วยข้อมูลจำลอง ทดสอบรวมล็อตรายวัน ขายข้ามล็อต สกุลเงินอิสระ เศษหุ้น ข้อมูลไม่ครบ การตัดซ้ำ/สิทธิ์ผู้ใช้ และยืนยันว่าหุ้นไทยไม่เปลี่ยนสูตร (development DB หลัง 016, BEGIN/ROLLBACK)
- `node verify-investment-sql.cjs tmp/cost-basis-validation`: รัน migrations 007–016 และ SQL ทั้งชุดใน PGlite แบบ in-memory ไม่อ่าน .env หรือเชื่อม Supabase จริง
