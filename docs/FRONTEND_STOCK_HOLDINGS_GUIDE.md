# แสดงยอดถือครองหุ้นและกองทุน

โลโก้สำหรับประวัติซื้อขาย: `includeClosed=true&includeLogos=true` คืนรูปหุ้นนอก/หุ้นไทยที่ขายหมดแล้วด้วย โดยไม่ต้องเปิด includeMarket/includeFx ดู [คู่มือ closed stock logos](FRONTEND_CLOSED_STOCK_LOGOS_GUIDE.md) เพื่อจับคู่กับ transactions; ไม่เปลี่ยนรูปแบบหรือราคาของประวัติเดิม

อัปเดตข้อมูลตลาด: includeMarket=true เพิ่มราคาหุ้นไทยจาก Yahoo Finance และ NAV กองทุนจาก SEC Open API แล้ว อ่าน [คู่มือ Frontend หุ้นไทย/กองทุน](FRONTEND_THAI_STOCK_AND_FUND_MARKET_GUIDE.md) สำหรับฟิลด์ใหม่ วิธีตั้ง SEC_API_KEY และสถานะที่ต้องรองรับ ไม่ต้องเพิ่ม SQL หรือ import ใหม่

อัปเดต 018: [ต้นทุนกองทุน Average Cost](FRONTEND_MUTUAL_FUND_AVERAGE_COST_GUIDE.md) ใช้ totalAmount รายคำสั่งจาก PDF โดยไม่รวมค่าธรรมเนียมแล้ว ไม่ต้องมี grossAmount ในข้อมูลเก่า

ล่าสุด 017: [วิธีต้นทุนแยกสินทรัพย์](FRONTEND_ASSET_COST_METHODS_GUIDE.md) คือหุ้นนอก Compressed FIFO / หุ้นไทย FIFO / กองทุน Average Cost โดยคงข้อมูลถือครองและยอดเงินเดิม

อัปเดต 016: เฉพาะหุ้นนอกใช้ [Compressed FIFO](FRONTEND_OFFSHORE_COMPRESSED_FIFO_GUIDE.md) แล้ว หุ้นไทย/กองทุนยังวิธีเดิม Frontend ต้องอ่านวิธีคิดจาก costBasisMethod ของแต่ละ item แทนการสมมุติวิธีเดียวทั้งพอร์ต ชื่อฟิลด์ต้นทุน/ยอดเงิน/จำนวนหุ้นยังเดิม

อัปเดตล่าสุด 015: มีต้นทุนเฉลี่ยและต้นทุนคงเหลือจาก gross แล้ว ดู [คู่มือต้นทุนเฉลี่ย](FRONTEND_HOLDINGS_COST_BASIS_GUIDE.md) ตัวอย่างในส่วน 009–012 ด้านล่างเป็น response รุ่นก่อนเพิ่ม amounts/costBasis และ `NO_COST_OR_MARKET_VALUE` เปลี่ยนเป็น `NO_MARKET_VALUE` หลังรัน 015

## เพิ่มกองทุน (SQL 012)

รัน `012_mutual_fund_holdings.sql` หลัง 001–011 แล้วใช้ GET /api/v1/trades/holdings เหมือนเดิม ไม่ต้องซิงค์/นำเข้าข้อมูลเดิมใหม่ กองทุนที่เป็น IMPORTED แล้วจะรวมทันที แต่ PREVIEW ยังไม่รวม ไม่มีการแก้จำนวนหน่วยต้นฉบับ

- scope เปลี่ยนเป็น `STOCKS_AND_MUTUAL_FUNDS` ให้ปรับ type/enum ใน Frontend หากเคยล็อกเป็น STOCK_BUY_SELL_ONLY
- แยก assetType เป็น OFFSHORE_STOCK / THAI_STOCK / MUTUAL_FUND สำหรับแท็บ/หมวดบนหน้าเว็บ
- กองทุนใช้ `symbol` และ `fundName` จากชื่อ/รหัสที่อ่านใน PDF เช่น KKP US500-UH-E ไม่ตัดช่องว่าง/ผสมคนละ share class และ exchange=null แสดงจำนวนเป็น “หน่วยลงทุน” ไม่ใช่ “หุ้น”
- จำนวนหน่วยกองทุน = SUBSCRIPTION + SWITCH_IN − REDEMPTION − SWITCH_OUT (รหัสใน PDF: SUB/SWI/RED/SWO) คิดแต่ละกองทุนแยกกัน ไม่เอาหน่วย switch-out ของกอง A ไปบวกให้กอง B โดยเดาจำนวนเอง ต้องมีรายการ switch-in ของ B ที่นำเข้าแล้วด้วย
- boughtUnits ของกองทุนคือ SUB อย่างเดียว soldUnits คือ RED อย่างเดียว เพิ่ม switchInUnits/switchOutUnits แยกไว้ acquiredUnits=SUB+SWI, disposedUnits=RED+SWO, quantity=acquiredUnits−disposedUnits
- หุ้นยัง BUY−SELL ตามเดิม switchInUnits/switchOutUnits=0 และเกณฑ์ปิดเศษ 011 ยังใช้เฉพาะหุ้น กองทุนไม่ปัดเป็นศูนย์ด้วย ±0.0000003 โดยอัตโนมัติ (roundingTolerance ของแถวนั้น=null, roundingAdjusted=false)
- rawQuantity/quantity, HELD/CLOSED/NEGATIVE, includeClosed และการกันคำสั่งซ้ำยังทำงานเหมือนเดิม รวมถึงการเตือนเมื่อมีรายการที่ยังไม่รองรับ ค่า duplicateOrdersExcluded ตอนนี้นับกองทุนด้วย
- Top-level roundingTolerance ยังเป็นเกณฑ์ของหุ้นเพื่อ compatibility มี roundingAppliesTo ระบุประเภทที่ใช้ อย่าเอาค่านี้ไปปัดหน่วยกองทุนเอง
- SQL 012 เดิมรวมเฉพาะจำนวนหน่วย; ต่อมา migration 018 เพิ่มต้นทุน Average Cost และ Backend เพิ่ม NAV/มูลค่าปัจจุบันผ่าน includeMarket=true ตามคู่มือข้อมูลตลาด ไม่ใช้ยอดเงินมาเดาจำนวนหน่วย

ตัวอย่างแถวกองทุน:

```json
{
  "assetType": "MUTUAL_FUND",
  "symbol": "KKP US500-UH-E",
  "fundName": "KKP US500-UH-E",
  "boughtUnits": 10,
  "soldUnits": 2,
  "switchInUnits": 3,
  "switchOutUnits": 1,
  "acquiredUnits": 13,
  "disposedUnits": 3,
  "rawQuantity": 10,
  "quantity": 10,
  "status": "HELD",
  "roundingAdjusted": false,
  "roundingTolerance": null
}
```

ทดสอบ SQL จริงด้วย `test/mutual-fund-holdings.integration.sql` บนฐานข้อมูลพัฒนาที่มี test auth user โดยข้อมูลจำลองทั้งหมดจะ ROLLBACK รวมทดสอบ SUB/SWI/RED/SWO, dedup และเศษหน่วยกองทุนที่ไม่ควรถูกปัดด้วยเกณฑ์หุ้น Unit/HTTP tests ไม่ได้ยืนยันการรัน SQL จริงแทนขั้นตอนนี้

อัปเดต SQL 011: ใช้เกณฑ์ **±0.0000003 หุ้น (3×10⁻⁷)** สำหรับปิดเศษยอดคงเหลือในชั้นแสดงผล ไม่ใช่ ±0.000003 และไม่ใช่ ±0.0000005 ต้องรัน `011_holdings_rounding_tolerance.sql` หลัง 010 โดยไม่ลบข้อมูลหรือแก้ units ใน transactions

เงื่อนไขคือ rawQuantity=BUY−SELL มีค่าสัมบูรณ์ไม่เกินเกณฑ์ มีจำนวนซื้อและขายทั้งคู่เป็นบวก ไม่มีรายการพิเศษที่ยังไม่นับของหลักทรัพย์/บัญชีนั้น และไม่มี ORDER_ID_COLLISION ของกลุ่มนั้น จึงให้ quantity=0/status=CLOSED/roundingAdjusted=true ถ้า rawQuantity=0 พอดี roundingAdjusted=false หุ้นที่ซื้อจำนวนน้อยแต่ไม่เคยขายจะไม่ถูกปรับเป็นศูนย์

ค่าดิบอยู่ใน rawQuantity เสมอ (เป็นผลรวมจาก units ต้นฉบับที่ยังเก็บในฐานข้อมูลครบ) ไม่เปลี่ยน boughtUnits/soldUnits และไม่ปัด units ในรายการซื้อขาย ค่า 0.0000005 หรือ -0.0000005 เกินเกณฑ์จึงไม่ถูกปรับ; ค่าติดลบที่ไม่เข้าเงื่อนไขยังเตือนตามเดิม

ตัวอย่างส่วนหนึ่งของ items เมื่อเรียก `?includeClosed=true`:

```json
{
  "rawQuantity": 0.0000002,
  "quantity": 0,
  "status": "CLOSED",
  "roundingAdjusted": true
}
```

ค่าเริ่มต้นยังซ่อน CLOSED รวมทั้งรายการที่ปิดด้วยเกณฑ์นี้ด้วย หากต้องตรวจยอดดิบให้เรียก includeClosed=true ระดับ response มี roundingTolerance=0.0000003 และ roundingAdjustedCount ซึ่งนับรายการที่ปรับทั้งหมดแม้ซ่อนอยู่ UI ใช้ quantity เป็นยอดแสดง ใช้ rawQuantity ตรวจย้อนหลัง และไม่ปรับเกณฑ์เองเป็น 0.0000005 การปิดนี้เป็นการประมาณจากข้อมูล PDF ไม่ใช่ยืนยันว่าบัญชี Dime ถือศูนย์จริง

การปัดเศษจากหลายรายการสามารถสะสมในทางคณิตศาสตร์ได้ แต่ยังไม่ได้ยืนยันนโยบาย Dime หรือเพดานข้อผิดพลาดจริง จึงไม่ขยายเกณฑ์อัตโนมัติตามจำนวนรายการ มีสคริปต์ทดสอบขอบเขต numeric ใน `test/holdings-rounding.integration.sql` ให้รันบนฐานข้อมูลพัฒนาหลัง 011 โดยไม่เขียนข้อมูลการเงิน

อัปเดต: หลังรัน SQL 010 จะตัดรายการซ้ำระดับเลขคำสั่งที่ตรงทั้ง identity และรายละเอียดออกจากยอดรวมด้วย ไม่ใช่กันเฉพาะเลข PDF ดู [คู่มือกันคำสั่งซ้ำ](ORDER_DEDUPLICATION_GUIDE.md) ข้อมูลเก่าที่ถูกทำเครื่องหมาย is_duplicate ยังอยู่ใน transactions เพื่อ audit แต่ไม่นับใน holdings และมี duplicateOrdersExcluded เพิ่ม หาก ORDER_ID_COLLISION หมายถึงคำสั่งเก่าเลขเดียวกันแต่รายละเอียดต่างกัน ยังไม่ได้เดารวมให้ ต้องตรวจสอบก่อน

## ตั้งค่า Backend

รัน `supabase/migrations/009_stock_holdings_buy_sell.sql` หลัง 001–008 ไม่ลบ/แก้รายการลงทุนเดิม ไม่ต้องเพิ่ม env SQL เพิ่ม RPC แบบอ่านอย่างเดียว ใช้ numeric ใน PostgreSQL รวมจำนวนหุ้น ไม่ดึงแค่ 1,000 แถวแรกมาคำนวณ และไม่เก็บตารางยอดคงเหลือซ้ำ

## API

```http
GET /api/v1/trades/holdings
Authorization: Bearer <Supabase access token>
```

คืนเฉพาะผู้ใช้ที่ Login ไม่ใช้ userId จาก query ส่ง `?includeClosed=true` เพื่อดูรายการที่ขายหมดด้วย ค่าเริ่มต้น false ไม่ส่ง quantity=0 แต่ยังส่งค่าติดลบเพื่อไม่ปิดบังข้อมูลขาดหาย ใช้ Cache-Control: no-store

```json
{
  "scope": "STOCKS_AND_MUTUAL_FUNDS",
  "calculatedAt": "2026-10-18T10:00:00Z",
  "includeClosed": false,
  "items": [
    {
      "assetType": "OFFSHORE_STOCK",
      "accountNumber": "12345678901",
      "symbol": "NVDA",
      "exchange": "XNAS",
      "currency": "USD",
      "boughtUnits": 2.5,
      "soldUnits": 0.75,
      "quantity": 1.75,
      "transactionCount": 3,
      "excludedTransactionCount": 0,
      "status": "HELD"
    }
  ],
  "excludedTransactions": [],
  "limitations": ["SUPPORTED_TRANSACTIONS_ONLY", "NO_COST_OR_MARKET_VALUE", "STOCK_ROUNDING_CLOSURE_IS_AN_ESTIMATE"],
  "warnings": []
}
```

## กติกา

- ใช้เฉพาะ investment_transactions ที่ document.status=IMPORTED ไม่รวม PREVIEW
- quantity = SUM(units ของ BUY) - SUM(units ของ SELL) ไม่ใช้ยอดเงินมาคำนวณจำนวนหุ้น
- รหัส SEL ถูก parser แปลงเป็น transaction_type=SELL ก่อนบันทึกแล้ว
- รวมทุกเอกสารที่นำเข้า ไม่ใช่เฉพาะช่วงเวลาซิงค์ล่าสุด ไม่ต้องอ่าน PDF ใหม่
- แยกกลุ่มตามตลาด (หุ้นนอก/ไทย), เลขบัญชี, symbol, exchange และ currency เพื่อไม่รวมคนละสินทรัพย์เพียงเพราะชื่อเหมือนกัน บัญชีเดียวกันซื้อ ticker เดิมหลายครั้งจะรวมเป็นหนึ่งแถว หลายบัญชีแสดงแยก ไม่รวมข้ามบัญชีในรอบนี้
- หุ้นไทย assetType=THAI_STOCK และ exchange อาจเป็น null ไม่ต้องเดาตลาดเพิ่มเอง
- status: HELD (>0), CLOSED (=0), NEGATIVE (<0) ใช้ quantity หลังใช้เกณฑ์ 011 เท่านั้น rawQuantity ยังเป็นยอดจริงจากการรวมรายการ อย่าแปลงค่าติดลบเกินเกณฑ์หรือไม่เข้าเงื่อนไขเป็น 0 ให้ระบุ “ประวัติซื้ออาจไม่ครบ” และให้ตรวจข้อมูล
- ยังไม่รวม REWARD/EXC/EXP ของหุ้น รายการพิเศษอยู่ใน excludedTransactions พร้อม symbol/account/type/count และมี SPECIAL_TRANSACTIONS_EXCLUDED เตือน ภายใต้หุ้นที่มี BUY/SELL ยังมี excludedTransactionCount ต่อแถวด้วย ส่วนกองทุนรวม SUB/RED/SWI/SWO แล้วตามกติกา SQL 012 ด้านบน
- หากมีแต่ REWARD ของตัวนั้น จะไม่แสดงแถวถือครองศูนย์หลอก ๆ แต่จะอยู่ใน excludedTransactions เพื่อให้รู้ว่ายังไม่นับครบ
- ถ้าขายมากกว่าซื้อ จะมี NEGATIVE_HOLDINGS ไม่เดารายการซื้อที่ขาดให้
- ไม่คำนวณต้นทุน ราคาปัจจุบัน มูลค่าพอร์ต กำไรขาดทุน หรือ FX ใน API นี้ currency เป็นข้อมูลสินทรัพย์ ไม่ได้หมายถึงจำนวนเงินหรือจำนวนหุ้นเป็น USD

## Frontend ที่ต้องทำ

1. หลังเปิดหน้าพอร์ตหรือยืนยัน import สำเร็จ เรียก GET /trades/holdings ใหม่
2. แสดงตาราง “หุ้นที่ถือ” จาก items โดยเน้น symbol และ quantity พร้อมแยกหุ้นนอก/หุ้นไทย บัญชี และตลาดเมื่อจำเป็น
3. ใช้คีย์ร่วม assetType/accountNumber/symbol/exchange/currency ไม่ใช้ symbol อย่างเดียว
4. หุ้นมีเศษหุ้นได้ อย่าปัด quantity เป็นจำนวนเต็ม ใช้รูปแบบทศนิยมที่เหมาะสมโดยไม่แก้ยอดจริง
5. หาก items ว่างและไม่มี excludedTransactions จึงแสดง “ยังไม่พบยอดถือครองจากรายการ BUY/SELL ที่นำเข้า” ไม่ยืนยันว่าผู้ใช้ไม่มีหุ้นจริง หากมีรายการพิเศษที่ยังไม่นับให้แสดงข้อจำกัดด้วย
6. ผลลัพธ์นี้ไม่ใช่ Preview ตอน sync และไม่รวมเอกสารที่ยังรอยืนยันนำเข้า

Error: 401 UNAUTHORIZED, 400 INVALID_HOLDINGS_FILTER, 503 INVESTMENT_STORAGE_UNAVAILABLE (ตรวจ SQL 009/DB)

## ทดสอบบน Supabase หลังรัน SQL

- BUY NVDA 2.5 + BUY 1 - SELL 0.75 → quantity=2.75
- BUY 0.1 + BUY 0.2 → quantity=0.3 ไม่ใช่ค่าคลาดเคลื่อนจากการบวกแบบ JS
- ซื้อและขายเท่ากัน → ไม่อยู่ในผลปกติ; includeClosed=true คืน CLOSED
- มีขายอย่างเดียว → quantity ติดลบพร้อมคำเตือน
- ticker เดียวกันคนละบัญชี/ตลาด/สกุลเงิน → ไม่รวมผิดกลุ่ม
- เอกสาร PREVIEW และข้อมูลของบัญชีผู้ใช้อื่น → ต้องไม่ถูกนับ
- นำเข้าเอกสารเดิมซ้ำ → quantity ไม่เปลี่ยน
- รายการเกิน 1,000 แถว → รวมครบทั้งชุดจาก SQL

Unit/HTTP tests ตรวจ API, สิทธิ์ และการส่งค่ากับ RPC จำลอง ยังไม่ได้ยืนยันการประมวลผล SQL บน Supabase จริงแทนรายการทดสอบนี้

## เพิ่มยอดเงินซื้อ–ขาย (migration 013)

Endpoint เดิมเพิ่ม `items[].amounts` สำหรับยอดรายสินทรัพย์ และ `moneyTotals` สำหรับยอดรวมแยกสกุลเงิน รวมเฉพาะรายการ IMPORTED ที่ไม่ซ้ำ ไม่ใช่ต้นทุนคงเหลือหรือราคาตลาดปัจจุบัน ดูฟิลด์ ตัวอย่าง JSON และกติกาแสดงผลใน [คู่มือยอดเงิน](FRONTEND_HOLDINGS_MONEY_GUIDE.md) ต้องรัน 013 หลัง 012 ก่อนใช้ฟิลด์ใหม่ โดยไม่ต้อง Import ข้อมูลเดิมใหม่

## แยก gross และค่าธรรมเนียม (migration 014)

อัปเดตล่าสุด: 015 เพิ่ม `items[].costBasis` สำหรับต้นทุนเฉลี่ย/ต้นทุนคงเหลือแบบ moving weighted average ไม่รวมค่าธรรมเนียม พร้อมยอดรวมแยกสกุลเงิน ดู [คู่มือต้นทุนเฉลี่ย](FRONTEND_HOLDINGS_COST_BASIS_GUIDE.md) ต้องรัน 015 หลัง 014 ก่อนใช้ฟิลด์ใหม่

รัน 014 หลัง 013 เพื่อเพิ่ม totalBuyGross/totalSellGross และค่าธรรมเนียมรวม VAT แยกซื้อ/ขาย/สับเปลี่ยนใน amounts และ moneyTotals โดยคง totalBuy/totalSell เดิมไว้ เพิ่ม stockMoneyTotals สำหรับยอดรวมเฉพาะหุ้นนอกและหุ้นไทย ส่วนลดระดับเอกสารยังไม่หักและ VAT ไม่ถูกบวกซ้ำ หุ้นไทย/กองทุนยังมี THB เท่านั้นตามเอกสาร และ gross กองทุนที่ไม่มีในข้อมูลจะเป็น null รายละเอียดและตัวอย่าง mapping อยู่ในคู่มือยอดเงินด้านบน
