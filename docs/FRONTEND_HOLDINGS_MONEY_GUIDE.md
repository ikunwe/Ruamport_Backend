# ยอดเงินซื้อ–ขายสำหรับหน้า Holdings

อัปเดต 018: กองทุนส่งต้นทุนเฉลี่ย/ต้นทุนคงเหลือใน costBasis โดยใช้ totalAmount รายคำสั่งแล้ว ดู [คู่มือกองทุน Average Cost](FRONTEND_MUTUAL_FUND_AVERAGE_COST_GUIDE.md) ฟิลด์ยอดซื้อขาย/gross ดิบใน amounts ด้านล่างไม่เปลี่ยน

ล่าสุด 017: วิธีต้นทุนคือหุ้นนอก Compressed FIFO / หุ้นไทย FIFO / กองทุน Average Cost ดู [คู่มือปัจจุบัน](FRONTEND_ASSET_COST_METHODS_GUIDE.md) ยอดซื้อขาย/gross/ค่าธรรมเนียมในเอกสารนี้ไม่เปลี่ยน

หมายเหตุล่าสุด: 015 เพิ่มต้นทุนคงเหลือ และ 016 เปลี่ยนเฉพาะหุ้นนอกเป็น [Compressed FIFO](FRONTEND_OFFSHORE_COMPRESSED_FIFO_GUIDE.md) ส่วนหุ้นไทย/กองทุนยังใช้วิธีเดิม โดยไม่เปลี่ยนความหมายของ totalBuy/totalSell หรือ gross/ค่าธรรมเนียมในคู่มือนี้

## เริ่มใช้งาน

รัน `supabase/migrations/013_holdings_money_totals.sql` หลัง 007–012 แล้วรัน `supabase/migrations/014_holdings_gross_and_fees.sql` ตามลำดับใน Supabase SQL Editor ไม่ต้องลบข้อมูลหรือ Import PDF ใหม่ ฟังก์ชันอ่านรายการเดิม ไม่มีการแก้ยอดดิบ หากรัน 013 แล้วให้รันเฉพาะ 014 เพิ่ม

ใช้ endpoint เดิม `GET /api/v1/trades/holdings` พร้อม Bearer token ไม่ต้องเพิ่ม request body หรือ env ตัวใหม่

ฟิลด์จำนวนหน่วยและสถานะเดิมยังอยู่ทั้งหมด 013 เพิ่ม `items[].amounts` และ `moneyTotals` ส่วน 014 เพิ่มยอด gross/ค่าธรรมเนียมลงใน amounts ทั้งสองจุด และเพิ่ม `stockMoneyTotals` สำหรับรวมเฉพาะหุ้น พร้อม metadata อธิบายขอบเขต

## ฟิลด์ใหม่

`items[].amounts` เป็น array ยอดเงินของสินทรัพย์/บัญชี/ตลาด/สกุลเงินกลุ่มนั้น:

| ฟิลด์ | ความหมาย |
| --- | --- |
| `currency` | สกุลเงินของยอดใน object นี้ |
| `totalBuy` | ยอดรวมช่อง totalAmount ฝั่งซื้อเดิม รวมค่าธรรมเนียมตามรูปแบบ PDF ไม่ใช่มูลค่าหุ้นล้วน หุ้นใช้ BUY กองทุนใช้ SUBSCRIPTION |
| `totalSell` | ยอดรวมช่อง totalAmount ฝั่งขายเดิม ไม่ใช่มูลค่าขายก่อนค่าธรรมเนียม หุ้นใช้ SELL กองทุนใช้ REDEMPTION |
| `totalSwitchIn` | มูลค่าสับเปลี่ยนกองทุนเข้า แยกจากซื้อด้วยเงินใหม่ |
| `totalSwitchOut` | มูลค่าสับเปลี่ยนกองทุนออก แยกจากขายรับเงิน |
| `netBuySellCashFlow` | totalBuy − totalSell เป็นผลต่างยอดซื้อ–ขาย ไม่รวม switch ไม่ใช่ต้นทุนคงเหลือ กำไร หรือเงินฝากเข้าพอร์ต |
| `orderCount` | จำนวนรายการที่นำมารวมสำหรับสกุลเงินนี้ |
| `missingAmountCount` | จำนวนรายการที่ขาดยอดเงินที่อ่านได้ |
| `isComplete` | ยอดเงินของรายการที่นำมารวมครบหรือไม่ ไม่ได้ยืนยันว่าซิงค์ประวัติครบทั้งบัญชี |

หุ้นนอกมีสกุลเดิม เช่น USD และ THB จาก PDF ส่วนหุ้นไทย/กองทุนมี THB เท่านั้น **ยังไม่แปลงหุ้นไทย/กองทุนเป็น USD** เพราะยังไม่มีแหล่ง FX ที่ตกลงกัน

`moneyTotals` ใช้โครงสร้างเดียวกับ amounts เป็นยอดรวมทุกสินทรัพย์ของผู้ใช้แยกตามสกุลเงิน ไม่รวมตัวเลขคนละสกุลเข้าด้วยกัน:

- THB: รวมยอด THB ของหุ้นนอก หุ้นไทย และกองทุน
- USD: รวมเฉพาะรายการที่มีจำนวนเงิน USD จาก PDF ไม่ใช่มูลค่าทั้งพอร์ตที่แปลงเป็น USD
- สกุลอื่นถ้ามี แยก object ของตัวเอง

metadata:

- `moneySource: "IMPORTED_ORDER_TOTALS"`
- `moneyTotalsScope: "ALL_IMPORTED_SUPPORTED_ORDERS_INCLUDING_CLOSED"`
- `moneyLimitations`: ข้อจำกัดของการตีความยอด

## ตัวอย่าง response บางส่วน

ตัวอย่างในหัวข้อนี้แสดงฟิลด์เดิมจาก 013 ส่วน gross/ค่าธรรมเนียมที่ต้องใช้แสดงมูลค่าหุ้นจริง ดูหัวข้อ migration 014 ด้านล่าง

```json
{
  "items": [
    {
      "assetType": "OFFSHORE_STOCK",
      "symbol": "AMD",
      "currency": "USD",
      "quantity": 1,
      "status": "HELD",
      "amounts": [
        {
          "currency": "THB",
          "totalBuy": 7000,
          "totalSell": 4200,
          "totalSwitchIn": 0,
          "totalSwitchOut": 0,
          "netBuySellCashFlow": 2800,
          "orderCount": 3,
          "missingAmountCount": 0,
          "isComplete": true
        },
        {
          "currency": "USD",
          "totalBuy": 200,
          "totalSell": 120,
          "totalSwitchIn": 0,
          "totalSwitchOut": 0,
          "netBuySellCashFlow": 80,
          "orderCount": 3,
          "missingAmountCount": 0,
          "isComplete": true
        }
      ]
    }
  ],
  "moneySource": "IMPORTED_ORDER_TOTALS",
  "moneyTotalsScope": "ALL_IMPORTED_SUPPORTED_ORDERS_INCLUDING_CLOSED",
  "moneyTotals": [
    {
      "currency": "THB",
      "totalBuy": 7000,
      "totalSell": 4200,
      "totalSwitchIn": 0,
      "totalSwitchOut": 0,
      "netBuySellCashFlow": 2800,
      "orderCount": 3,
      "missingAmountCount": 0,
      "isComplete": true
    },
    {
      "currency": "USD",
      "totalBuy": 200,
      "totalSell": 120,
      "totalSwitchIn": 0,
      "totalSwitchOut": 0,
      "netBuySellCashFlow": 80,
      "orderCount": 3,
      "missingAmountCount": 0,
      "isComplete": true
    }
  ]
}
```

ตัวอย่างสมมุติว่ามีสินทรัพย์เดียว หากมีสินทรัพย์อื่น moneyTotals จะต่างจาก amounts ของ AMD

## กติกาที่ Frontend ต้องใช้

1. เลือกสกุลเงินด้วย `.find(row => row.currency === 'THB')` หรือ `'USD'` ไม่ยึดตำแหน่ง array
2. ถ้า `totalBuy` หรือยอดอื่นเป็น null ให้แสดง “ข้อมูลไม่ครบ” หรือ `—` **อย่าใช้ `?? 0`** หากไม่มีรายการของประเภทนั้นจริง ระบบจะส่ง 0 เอง
3. ยอดรวมด้านบนใช้ `moneyTotals` ไม่ sum จาก items เพราะโดยปกติ items ซ่อนสินทรัพย์ขายหมดแล้ว แต่ยอดประวัติยังต้องรวมสินทรัพย์เหล่านั้น ใช้ `?includeClosed=true` เมื่อต้องการแสดงแต่ละรายการขายหมดด้วย
4. ยอด USD กับ THB เป็นสองหน่วยแสดงของข้อมูลเดียวกันในหุ้นนอก ห้ามบวกสองสกุลเข้าด้วยกัน
5. หลัง 014 ป้าย “มูลค่าซื้อสะสมก่อนค่าธรรมเนียม”/“มูลค่าขายสะสมก่อนค่าธรรมเนียม” ใช้ totalBuyGross/totalSellGross ส่วน totalBuy/totalSell เดิมใช้แสดงยอดรวมช่อง totalAmount เท่านั้น ไม่ใช้ชื่อ “มูลค่าปัจจุบัน” หรือ “ต้นทุนคงเหลือ” สำหรับยอดเหล่านี้
6. หลัง 015 ต้นทุนคงเหลืออยู่ใน costBasis ไม่ใช่ amounts ยังไม่ส่งราคาตลาดล่าสุด NAV ล่าสุด กำไรขาดทุน หรือเรต FX สด และห้ามใช้ totalBuy − totalSell เป็นตัวแทนยอดเหล่านั้น

## แหล่งยอดและข้อจำกัด

- รวม `investment_transactions.details.totalAmount` จากเอกสาร IMPORTED ของ user ที่ล็อกอินเท่านั้น ไม่รวม PREVIEW หรือ `is_duplicate=true`
- หุ้นนอกใช้ `totalAmount.foreign` และ `totalAmount.thb` ตาม PDF หุ้นไทย/กองทุนใช้ totalAmount ตัวเลข THB ไม่ใช้ units × price คำนวณทับยอดเอกสาร
- ยอดเป็นผลรวมระดับคำสั่ง ไม่ใช่ผลรวม summary ของทุก PDF เพราะ summary อาจมีรายการคำสั่งซ้ำกันข้าม PDF
- ไม่หักส่วนลดระดับเอกสารซ้ำ ไม่บวกค่าธรรมเนียมซ้ำ ไม่มีการกระจายส่วนลด/ภาษีระดับเอกสารลงแต่ละสินทรัพย์ จึงอาจไม่เท่ายอดสรุปสุทธิของเอกสาร โปรดอย่าเรียกยอดนี้ว่ายอดเงินออกจากบัญชีจริงทั้งหมด
- คำเตือนยอดรวมไม่ตรง PDF ไม่ทำให้รายการ IMPORTED ถูกตัดจากยอดนี้ ส่วน REWARD/EXERCISE หรือประเภทที่ยังไม่รองรับ ไม่ถูกนับ และยังมี excludedTransactions/warnings เดิมให้ตรวจสอบ
- หากข้อมูลคำสั่งมี collision ที่ยังไม่ถูกแก้ จะคงคำเตือน ORDER_ID_COLLISION ไม่รับประกันความถูกต้องของยอดจนกว่าจะตรวจสอบ
- คำนวณด้วย numeric ใน PostgreSQL โดยไม่เปลี่ยนยอดเก็บจริง Frontend ปัดเพื่อแสดงผลได้ แต่ไม่ควรนำตัวเลขที่ปัดแล้วกลับมาบันทึกแทนยอดเดิม

## ทดสอบ

`npm test` ตรวจ response contract และ routing โดย mock ฐานข้อมูล ส่วน `test/holdings-money.integration.sql` ใช้ทดสอบ PostgreSQL จริงในฐานข้อมูลพัฒนาที่มี test auth user หลังรัน 013 แล้ว script ใช้ BEGIN/ROLLBACK ไม่เก็บรายการตัวอย่างถาวร

หลัง 016 ใช้ต้นทุนคงเหลือจาก costBasis ตามวิธีของแต่ละ assetType (หุ้นนอก Compressed FIFO ประเภทอื่นวิธีเดิม) แยกจาก “มูลค่าตลาดล่าสุด” ซึ่งยังต้องเลือกแหล่งราคา/FX โดยให้แต่ละราคาและเรตมี source/asOf เพื่อไม่ให้เข้าใจผิดว่าเรตอ้างอิงคือเรตที่แลกเงินจริงใน Dime

## Migration 014: แยกมูลค่าซื้อขายกับค่าธรรมเนียมรวม VAT

ฟิลด์ต่อไปนี้อยู่ในทุก object สกุลเงินของ `items[].amounts`, `moneyTotals` และ `stockMoneyTotals`:

| ฟิลด์ | ความหมาย |
| --- | --- |
| `totalBuyGross` | รวม grossAmount ฝั่ง BUY/SUBSCRIPTION ก่อนค่าธรรมเนียม |
| `totalSellGross` | รวม grossAmount ฝั่ง SELL/REDEMPTION ก่อนค่าธรรมเนียม |
| `totalSwitchInGross` / `totalSwitchOutGross` | gross ของรายการสับเปลี่ยน ถ้าไม่มีข้อมูลจะเป็น null เมื่อมีรายการประเภทนั้น |
| `grossIsComplete` | รายการที่นำมารวมมีข้อมูล gross ครบหรือไม่ แยกจาก isComplete เดิม |
| `missingGrossAmountCount` | จำนวนรายการที่ไม่มี gross ที่ใช้ได้ในสกุลเงินนี้ |
| `totalBuyFeeIncludeVat` | ค่าธรรมเนียมรวม VAT สะสมฝั่งซื้อ |
| `totalSellFeeIncludeVat` | ค่าธรรมเนียมรวม VAT สะสมฝั่งขาย |
| `totalSwitchInFeeIncludeVat` / `totalSwitchOutFeeIncludeVat` | ค่าธรรมเนียมรวม VAT ของการสับเปลี่ยน แยกต่างหาก |
| `totalFeeIncludeVat` | ผลรวมค่าธรรมเนียมทั้งซื้อ ขาย สับเปลี่ยนเข้า และสับเปลี่ยนออก |
| `feeIsComplete` | ค่าธรรมเนียมของรายการที่รวมครบหรือไม่ ไม่ได้อ้างอิง grossIsComplete |
| `missingFeeAmountCount` | จำนวนรายการที่ไม่มีค่าธรรมเนียมที่ใช้ได้ในสกุลเงินนี้ |

ไม่มีรายการของฝั่งใด = 0; มีรายการแต่ข้อมูลของฝั่งนั้นขาด = null ไม่คืนยอดรวมบางส่วนที่ดูเหมือนครบ ค่า 0 ใน PDF เป็นค่าที่ใช้ได้จริง เช่น รายการที่ระบุค่าธรรมเนียมเป็น 0

### ตัวอย่างการอ่านฟิลด์ใหม่

ตัวอย่างหุ้นนอกซื้อยอดรวม 30 USD เป็นมูลค่าหุ้น 29.95 USD + ค่าธรรมเนียมรวม VAT 0.05 USD และขายมูลค่า 40.10 USD หักค่าธรรมเนียมรวม VAT 0.10 USD เหลือ totalAmount 40 USD โดยสมมุติยอด THB ใน PDF เป็นดังนี้:

```json
{
  "symbol": "AMD",
  "amounts": [
    {
      "currency": "USD",
      "totalBuy": 30,
      "totalSell": 40,
      "totalBuyGross": 29.95,
      "totalSellGross": 40.1,
      "totalBuyFeeIncludeVat": 0.05,
      "totalSellFeeIncludeVat": 0.1,
      "totalSwitchInFeeIncludeVat": 0,
      "totalSwitchOutFeeIncludeVat": 0,
      "totalFeeIncludeVat": 0.15,
      "grossIsComplete": true,
      "missingGrossAmountCount": 0,
      "feeIsComplete": true,
      "missingFeeAmountCount": 0
    },
    {
      "currency": "THB",
      "totalBuy": 1050,
      "totalSell": 1400,
      "totalBuyGross": 1048.25,
      "totalSellGross": 1403.5,
      "totalBuyFeeIncludeVat": 1.75,
      "totalSellFeeIncludeVat": 3.5,
      "totalSwitchInFeeIncludeVat": 0,
      "totalSwitchOutFeeIncludeVat": 0,
      "totalFeeIncludeVat": 5.25,
      "grossIsComplete": true,
      "missingGrossAmountCount": 0,
      "feeIsComplete": true,
      "missingFeeAmountCount": 0
    }
  ]
}
```

ตัวอย่างเป็นบางฟิลด์ของ items หนึ่งตัว ไม่ใช่ response ทั้งหมด ตัวเลข THB อ่านจาก PDF ไม่คำนวณโดยใช้เรต 35 ที่ฝั่ง Frontend

### แหล่งข้อมูลและขอบเขต

- หุ้นนอก: grossAmount.foreign/thb และ feeIncludeVat.foreign/thb โดยตรง ไม่ใช้ totalAmount ลบค่าธรรมเนียมเพื่อสร้าง gross และไม่บวก VAT ซ้ำ ไม่รวม withholdingTax เข้ากับค่าธรรมเนียม
- หุ้นไทย: grossAmount โดยตรง ส่วนค่าธรรมเนียมรวม VAT = feeExcludeVat + vat ถ้าขาดช่องใดช่องหนึ่งถือว่าข้อมูลค่าธรรมเนียมไม่ครบ
- กองทุน: feeIncludeVat ใช้ค่าที่ parser เก็บอยู่แล้ว **แต่ parser ปัจจุบันยังไม่มี grossAmount แยกสำหรับกองทุน** จึงส่ง gross เป็น null เมื่อมีรายการ ไม่ใช้ totalAmount หรือ units × NAV มาคาดเดาแทน
- หุ้นไทย/กองทุนส่ง THB ตามเอกสาร ไม่สร้างยอด USD ด้วยเรตสมมุติ ส่วนหุ้นนอกส่งทั้ง USD (หรือสกุลเดิม) และ THB เมื่อเอกสารมีข้อมูล
- ข้อมูลเก่าที่ขาด gross/fee จะส่ง null และจำนวนรายการที่ขาด ไม่ต้อง Import ใหม่สำหรับรายการที่มีข้อมูลเดิมครบอยู่แล้ว

### ยอดรวมไหนเหมาะกับหน้าจอไหน

- `moneyTotals`: รวมทุกสินทรัพย์ที่รองรับ รวมกองทุนด้วย แยกสกุลเงิน ดังนั้น gross ของยอด THB บางฝั่งอาจเป็น null หากกองทุนไม่มี gross ไม่ควรข้าม null แล้วนำยอดหุ้นล้วนไปเรียกว่าครบทั้งพอร์ต
- `stockMoneyTotals`: เพิ่มใน 014 รวมเฉพาะหุ้นนอกและหุ้นไทยที่เป็น BUY/SELL ไม่รวมกองทุน เหมาะสำหรับการ์ด “มูลค่าซื้อหุ้นสะสม”, “มูลค่าขายหุ้นสะสม” และ “ค่าธรรมเนียมหุ้นรวม VAT”
- `items[].amounts`: ใช้แสดงยอดและค่าธรรมเนียมรายสินทรัพย์/บัญชี/ตลาดตามกลุ่มเดิม
- ยอดรวมทั้งสองชุดรวมสินทรัพย์ CLOSED เสมอ แม้ includeClosed=false จะซ่อนสินทรัพย์นั้นจาก items
- USD ในยอดรวมครอบคลุมเฉพาะข้อมูล USD ที่มีอยู่ ไม่ใช่ทั้งพอร์ตแปลงเป็น USD ยอด USD และ THB ของหุ้นนอกห้ามนำมาบวกกัน

metadata ใหม่:

```json
{
  "grossSource": "PDF_ORDER_GROSS_AMOUNT",
  "feeSource": "PDF_ORDER_FEES_INCLUDE_VAT_BEFORE_DOCUMENT_DISCOUNTS",
  "documentDiscountsApplied": false,
  "stockMoneyTotalsScope": "ALL_IMPORTED_STOCK_BUY_SELL_INCLUDING_CLOSED"
}
```

ค่าธรรมเนียมชุดนี้เป็น “ค่าธรรมเนียมรวม VAT ตามรายการ (ยังไม่หักส่วนลดระดับเอกสาร)” ไม่ใช่ยอดค่าธรรมเนียมสุทธิที่ยืนยันว่าจ่ายจริงหลังส่วนลด ระบบไม่กระจาย/หัก summary.discount เข้ารายสินทรัพย์ และไม่ได้เพิ่มการรวมส่วนลดในรอบนี้ ข้อมูลส่วนลดเดิมในเอกสารยังคงอยู่

ตัวอย่าง mapping ใน Frontend:

```js
const usd = item.amounts.find(row => row.currency === 'USD');
const thb = item.amounts.find(row => row.currency === 'THB');
const stockThb = response.stockMoneyTotals.find(row => row.currency === 'THB');
// แสดง null/undefined เป็น “—” ไม่ใช่ 0
const boughtStockUsd = usd?.totalBuyGross;
const soldStockThb = thb?.totalSellGross;
const feesForThisAssetUsd = usd?.totalFeeIncludeVat;
const allStockFeesThb = stockThb?.totalFeeIncludeVat;
```

Migration 014 ไม่แก้การตัดซ้ำ สิทธิ์ผู้ใช้ จำนวนหน่วย ตรรกะส่วนต่างการปัดเศษ หรือยอดเดิมของ totalBuy/totalSell การทดสอบ SQL จริงสำหรับฟิลด์ใหม่อยู่ใน `test/holdings-gross-fees.integration.sql` (development DB หลัง 014, BEGIN/ROLLBACK)
