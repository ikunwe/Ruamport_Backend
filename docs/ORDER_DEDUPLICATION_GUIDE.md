# กันคำสั่งซื้อ/ขายซ้ำข้ามเลข PDF

## ตั้งค่า

รัน `supabase/migrations/010_order_level_deduplication.sql` หลัง 001–009 ไม่ต้องลบข้อมูลหรือเพิ่ม env แล้ว restart Backend ก่อนใช้กับข้อมูลจริงควรสำรองข้อมูล และอ่านพฤติกรรม backfill ด้านล่าง

## ตรวจอะไร

นอกเหนือจาก hash/เลขเอกสาร จะตรวจคำสั่งเป็นรายรายการ โดยใช้ผู้ใช้ + ชนิดสินทรัพย์ + เลขบัญชี + หุ้น/กองทุน + ตลาด + สกุลเงิน + ประเภทรายการ + เลขคำสั่ง + วันที่คำสั่งมีผล

ไม่ใช้เลขคำสั่งสั้น ๆ เพียงอย่างเดียว เพราะอาจใช้ซ้ำคนละวัน/บัญชี/หุ้น การเปลี่ยนเลข PDF/ชื่อไฟล์ไม่เปลี่ยน identity ของคำสั่ง หากไม่มีเลขบัญชี/เลขคำสั่ง/วันที่/หลักทรัพย์ จะไม่เดาว่าเป็นคำสั่งเดียวกัน คืน ORDER_IDENTITY_INCOMPLETE และยังอาศัยการกันซ้ำระดับเอกสารเดิม

เมื่อตรง identity แล้วจะเทียบรายละเอียดรายการทั้งหมดด้วย (ยกเว้น transactionCode เพราะ SEL/SELL แปลงเป็น SELL เดียวกัน) ตัวเลข JSONB เทียบตามค่าตัวเลข ไม่ใช่จำนวนตำแหน่งทศนิยม

- identity และรายละเอียดตรงกัน: ข้ามรายการซ้ำ ไม่เพิ่มหุ้น/เงินลงทุนซ้ำ
- เอกสารมีรายการซ้ำ 2 และใหม่ 1: สร้างเฉพาะรายการใหม่ 1 รายการ
- เอกสารมีแต่รายการซ้ำ: เปลี่ยนเอกสารเป็น IMPORTED เพื่อจำว่าประมวลผลแล้ว แต่ transactionCount=0 และ duplicateOrderCount>0 ไม่ได้หมายถึงซื้อหุ้นเพิ่ม
- identity ตรงแต่จำนวน/ราคา/ค่าธรรมเนียมหรือรายละเอียดต่างกัน: ORDER_ID_CONFLICT ไม่มีการ insert รายการใดจากเอกสารนั้น และคง PREVIEW ไว้ตรวจสอบ อาจเป็นฉบับแก้ไขหรือ partial fill จึงไม่ตัดทิ้ง/เขียนทับเอง ข้อนี้เป็นความขัดแย้งของ identity ไม่ใช่คำเตือนยอดรวมไม่ตรง ซึ่งยังยืนยันได้ตาม SQL 008
- คำขอ import ของผู้ใช้เดียวกันล็อกใน DB พร้อม unique index กันคำขอหลาย process พร้อมกัน

## ตัวอย่างผลนำเข้า

```json
{
  "documentId": "uuid-of-new-pdf",
  "outcome": "IMPORTED",
  "transactionCount": 1,
  "duplicateOrderCount": 2,
  "duplicateOrders": [
    {
      "orderId": "076258",
      "existingTransactionId": "uuid-of-original-order",
      "existingDocumentId": "uuid-of-original-pdf",
      "existingPdfNumber": "original-pdf-document-number"
    }
  ],
  "warnings": [{ "code": "DUPLICATE_ORDERS_SKIPPED", "count": 2, "blocking": false }],
  "hasWarnings": true
}
```

ตัวอย่างรายการ duplicateOrders ย่อให้ดูหนึ่งรายการ จำนวนจริงขึ้นกับเอกสาร Frontend แสดง “เพิ่ม 1 รายการ / ข้ามคำสั่งซ้ำ 2 รายการ” และเปิดเอกสารเดิมผ่าน GET /trades/documents/:id ได้ ตรวจ outcome ทุกเอกสาร อย่าถือ HTTP 200 เป็นความสำเร็จทุกกรณี ORDER_ID_CONFLICT จัดใน counts.failed และไม่แสดงว่าบันทึกแล้ว

ผลการ import ที่สำเร็จเก็บใน document.preview.importResult เพื่อดูย้อนหลัง เพิ่ม record.importedOrderCount และ duplicateOrderCount (เอกสารเก่าที่ไม่มี importResult เป็น null) orderCount เดิมยังเป็นจำนวนรายการที่อ่านจาก PDF ไม่ใช่จำนวนที่สร้างใหม่

## ข้อมูลเก่าที่ซ้ำก่อนรัน 010

Migration คำนวณ order_identity_key/order_signature ให้รายการเก่า แล้วทำเครื่องหมายรายการที่ตรงกันทั้ง identity และรายละเอียดว่า `is_duplicate=true` พร้อม `duplicate_of` ชี้รายการแรก ไม่ DELETE แถวหรือเอกสาร และไม่แก้ยอดตาม PDF

GET /trades/holdings หลัง 010 จะไม่นับแถวที่ถูกทำเครื่องหมายซ้ำ มี duplicateOrdersExcluded บอกจำนวนรายการหุ้นเก่าที่ตัดออก ส่วน GET /trades/transactions ยังคืนแถวเหล่านี้เพื่อ audit ผู้ที่รวมยอดเองต้องกรอง is_duplicate=false ไม่เช่นนั้นยังเห็นหุ้นเกิน

ถ้าข้อมูลเก่าเลขคำสั่งเดียวกันแต่รายละเอียดต่างกัน จะไม่รวม/ตัดทิ้งเอง ยังคงข้อมูลไว้และส่ง ORDER_ID_COLLISION ใน holdings ให้ตรวจว่าเป็นรายการย่อยหรือรายการแก้ไขก่อน ไม่รับรองว่ากติกานี้แก้ยอด AMD ทุกกรณีโดยไม่ตรวจเอกสาร

ห้ามรวมยอดลงทุนด้วยการบวก summary หรือ calculation.investmentTotals ของทุก PDF ตรง ๆ เพราะ PDF ใหม่อาจมีคำสั่งเก่าปนอยู่ ควรใช้ investment_transactions ที่ไม่ซ้ำเป็นฐานคำนวณประวัติลงทุน ส่วน summary/display/calculation ในแต่ละ PDF คงไว้เพื่อเทียบเอกสาร

## ทดสอบ

หลังรัน 010 ทดสอบนำเข้า PDF ต่างเลขแต่คำสั่งเดียวกัน ยอดหุ้นต้องไม่เพิ่ม ทดสอบเอกสารผสมเก่า/ใหม่, คำสั่งเลขเดียวกันต่างวัน/บัญชี, คำขอพร้อมกัน และ identity เดียวกันที่ค่าต่างกันต้องไม่เกิดการบันทึกครึ่งเอกสาร

มีสคริปต์ `test/order-deduplication.integration.sql` สำหรับ **ฐานข้อมูลพัฒนา** ที่มี test auth user เท่านั้น สร้างข้อมูลทดสอบใน transaction แล้ว ROLLBACK ตอนจบ ไม่ควรรันบน production ระหว่างผู้ใช้ใช้งาน Unit/HTTP tests ใช้ repository จำลอง ส่วน SQL/backfill/unique constraints ต้องยืนยันกับ PostgreSQL/Supabase จริง
