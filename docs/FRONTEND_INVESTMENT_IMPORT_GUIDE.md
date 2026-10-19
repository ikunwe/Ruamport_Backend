# บันทึกรายการลงทุนและประวัติอ่าน PDF

อัปเดต SQL 010: กันซ้ำรายคำสั่งข้ามเลขเอกสารแล้ว ผล import มี transactionCount (จำนวนที่สร้างจริง), duplicateOrderCount และ duplicateOrders ซึ่งอ้างเลขเอกสารเดิม เอกสารที่มีแต่รายการซ้ำอาจ IMPORTED แต่สร้าง 0 รายการ ถ้า ORDER_ID_CONFLICT แปลว่าเลขคำสั่งเดียวกันแต่รายละเอียดต่างกัน ต้องตรวจสอบและยังไม่บันทึกทั้งเอกสาร ดู [คู่มือกันคำสั่งซ้ำ](ORDER_DEDUPLICATION_GUIDE.md) การยืนยันเมื่อมีคำเตือนยอดรวมไม่ตรงยังทำงานเหมือน SQL 008

## ต้องทำก่อนใช้

รัน `supabase/migrations/007_investment_import_and_pdf_history.sql` หลัง 001–006 และรัน **008_import_with_nonblocking_warnings.sql** เพื่อให้ยืนยันนำเข้าเมื่อมีคำเตือนยอดไม่ตรงกันได้ ถ้ามี 007 แล้วรันเฉพาะ 008 เพิ่ม ไม่ต้องลบตาราง/ข้อมูลเดิม ไม่ต้องเพิ่ม env แล้ว restart Backend หากยังไม่รัน migration ที่ต้องใช้จะได้ 503 หรือ RPC เก่ายังบล็อกด้วย VALIDATION_REQUIRED

เพิ่ม 3 ตาราง: investment_documents (เอกสาร/Preview ที่อ่านแล้ว), investment_transactions (รายการที่ยืนยันนำเข้าแล้ว), gmail_pdf_history (ผูกไฟล์แนบกับเอกสาร/จำไฟล์ที่ไม่รองรับ) เปิด RLS และให้ service_role ฝั่ง Backend เท่านั้น Client ห้ามอ่าน/เขียนตารางหรือเรียก RPC ตรง ทุก API จำกัดข้อมูลด้วยผู้ใช้จาก Supabase access token

**เปลี่ยนจากเดิม:** เก็บข้อมูลการเงินที่ parse แล้วทั้ง summary/display/calculation/diagnostics และชื่อไฟล์ในฐานข้อมูล แต่ไม่เก็บ bytes PDF, ข้อความดิบ, เนื้อหาเมล, รหัส PDF หรือ token ในตารางเหล่านี้ ต้องปรับ Privacy Policy ให้ตรงการเก็บข้อมูลใหม่นี้

## Flow

1. Upload หรือ Gmail sync เดิม ตรวจ history/hash ก่อน parse
2. PDF ใหม่ที่อ่านสำเร็จเก็บเป็น **PREVIEW** หมายถึง “อ่านแล้ว รอยืนยัน” คืน record.id เป็น UUID จาก Backend ยังไม่ใช่รายการลงทุน
3. Frontend แสดงยอดตาม PDF เหมือนเดิม (หุ้นนอกใช้ display) ปุ่ม “ยืนยันนำเข้า” เปิดเมื่อ record.canImport=true
4. กดปุ่ม → POST /trades/import ส่งเฉพาะ documentIds ไม่ส่ง Preview/รายการ/ยอดเงินกลับ Backend ใช้ข้อมูลที่เก็บไว้เอง
5. DB บันทึกรายการทั้งหมดในเอกสารแล้วเปลี่ยนเป็น **IMPORTED** ใน transaction เดียว ถ้ารายการหนึ่งล้มเหลว rollback ทั้งเอกสาร
6. กดซ้ำหรือ sync ซ้ำคืนสถานะเดิม ไม่สร้างรายการลงทุนเพิ่ม
7. เรียก GET documents/transactions เพื่อดูข้อมูลที่เก็บ ไม่ต้องเปิด PDF ใหม่

Preview ที่เคยอ่านก่อนมี SQL 007 ยังไม่มีประวัติใน DB จึงต้องอ่านอีกครั้งเพื่อสร้างประวัติครั้งแรก หลังจากนั้นจึงข้ามการอ่านซ้ำได้

ยังไม่ auto-import จาก Gmail และยังไม่คำนวณพอร์ตคงเหลือ/ต้นทุน/ราคาปัจจุบัน

## Endpoint ใต้ /api/v1

ทั้งหมดใช้ Authorization: Bearer <Supabase access token> และ Cache-Control: no-store

| Method | Path | หน้าที่ |
|---|---|---|
| POST | /trades/upload-preview | multipart เดิม ตอนนี้บันทึก/ใช้ Preview เดิมและคืน record เพิ่ม |
| POST | /mail/gmail/sync-preview | ซิงค์เดิม เพิ่ม ALREADY_READ / ALREADY_IMPORTED |
| POST | /trades/import | ยืนยันนำเข้า 1–50 เอกสารต่อคำขอ |
| GET | /trades/documents?offset=0&limit=20 | ประวัติเอกสาร PREVIEW/IMPORTED |
| GET | /trades/documents/:id | Preview เต็มและสถานะล่าสุด |
| GET | /trades/transactions?offset=0&limit=20 | รายการลงทุนที่ยืนยันนำเข้าแล้ว |

ไม่ใช้ userId จาก body/query เพื่อเลือกบัญชีเด็ดขาด

## record ที่เพิ่มใน response

```json
{
  "id": "00000000-0000-4000-8000-000000000001",
  "status": "PREVIEW",
  "alreadyRead": false,
  "readAt": "2026-10-18T00:00:00Z",
  "importedAt": null,
  "orderCount": 3,
  "hasWarnings": false,
  "canImport": true
}
```

Upload: response.record; Gmail: results[i].record (ไม่ใช่ preview.record) ส่วนข้อมูล Preview ของ Gmail ยังอยู่ที่ results[i].preview

- PREVIEW: อ่านและเก็บ Preview แล้ว แต่ยังไม่สร้าง investment_transactions
- IMPORTED: บันทึกรายการแล้ว ปิดปุ่มยืนยัน แสดงวันนำเข้า
- alreadyRead=true: คืนข้อมูลจากเอกสารเดิม ไม่ใช่ error
- canImport=false ใน PREVIEW: ไม่มีเลขเอกสารสำหรับกันซ้ำ ไม่ใช่เพราะคำเตือนยอดไม่ตรงกัน เมื่อ validation.isValid=false แต่ canImport=true ผู้ใช้ยังกดยืนยันได้ ห้าม Frontend ใช้ isValid มาปิดปุ่มอีกต่อไป hasWarnings เป็นตัวช่วยแสดงคำเตือนเท่านั้น
- orderCount: จำนวนรายการในเอกสาร ไม่ใช่จำนวนหุ้นคงเหลือ

เมื่อเลขเอกสารเดิมอยู่ใน PDF bytes ต่างกัน จะใช้เอกสารแรก ไม่เขียนทับรายการเดิม ชื่อ preview.file อาจเป็นชื่อไฟล์แรกที่เคยอ่าน ส่วน source.filename คือชื่อไฟล์แนบที่ตรวจพบรอบนี้

## สถานะ Gmail ที่ UI ต้องเพิ่ม

| status | ข้อความ UI | ข้อมูล |
|---|---|---|
| READY | อ่านสำเร็จ รอยืนยันนำเข้า | preview + record |
| ALREADY_READ | อ่านแล้ว รอยืนยันนำเข้า ข้ามการอ่านซ้ำ | record เท่านั้น ไม่ส่ง preview เก่า เปิดผ่าน GET documents/:id |
| ALREADY_IMPORTED | บันทึกเข้าระบบแล้ว ข้ามการอ่านซ้ำ | record เท่านั้น เปิดรายละเอียดผ่าน GET documents/:id |

ห้ามถือว่า status !== READY คือ error เสมอไป ให้แยกสองสถานะใหม่เป็นสถานะปกติ เลือกนำเข้าจาก record.id ที่ไม่ซ้ำ เพราะหลายไฟล์แนบอาจเป็นเอกสารเดียวกัน

ไฟล์ที่อ่านสำเร็จแล้วไม่ต้องใส่รหัส PDF เพื่อดูข้อมูลที่เก็บไว้อีก แต่ต้อง Login เป็นเจ้าของ ส่วน PASSWORD_REQUIRED / PASSWORD_INVALID / PARSE_FAILED / LIMIT_SKIPPED / MAIL_READ_FAILED ยังแสดงและ retry ตามเดิม ไฟล์ที่ผิดพลาดไม่ถูกจำว่าอ่านสำเร็จ Monthly/Gold/ประเภทอื่นยังซ่อนและจำ IGNORED เพื่อไม่เปิดซ้ำ

counts ต่อชุดเพิ่ม alreadyRead, alreadyImported นอกเหนือจาก ready (อ่านใหม่) และ failed (ไม่รวมสองสถานะใหม่) progress.readyPdfCount นับเฉพาะ READY ใหม่ ไม่รวม ALREADY_READ และมี progress.alreadyReadPdfCount / progress.alreadyImportedPdfCount สะสม ส่วน foundPdfCount ยังนับไฟล์แนบทั้งหมด รวมไฟล์ซ้ำ/Monthly/Gold ไม่ใช่จำนวนเอกสารไม่ซ้ำ

### ซิงค์ซ้ำแล้วไม่แสดง Preview เก่า

- เริ่มกดซิงค์ใหม่ให้ล้างรายการ Preview/ผลการโหลดชุดก่อนใน UI และไม่ส่ง cursor เก่า (ประวัติรอยืนยันดูได้จาก GET documents ไม่หายไปจาก DB)
- ระหว่างโหลดแสดง “กำลังตรวจหาไฟล์ใหม่” ไม่ใช้คำว่า “กำลังอ่าน PDF ใหม่ทั้งหมด” เพราะไฟล์เดิมเช็ก history แล้วข้าม download/parse
- เพิ่มการ์ด Preview เฉพาะ `status === 'READY' && item.preview` เท่านั้น ALREADY_READ/ALREADY_IMPORTED เป็นรายการข้ามหรือ badge สรุปจำนวน ไม่มี preview แนบมาแล้ว
- `hasNewData` บอกว่าตั้งแต่เริ่มรอบ cursor นี้มี READY ใหม่หรือไม่ ไม่ใช่ดูเฉพาะหน้าสุดท้าย
- `syncStatus = SCANNING`: ยังต้องโหลด nextCursor ต่อจน hasMore=false แม้หน้าแรกจะมีแต่รายการเก่า ห้ามสรุปว่าไม่มีข้อมูลใหม่ก่อนตรวจครบ
- `syncStatus = NO_NEW_DATA`, `noNewData = true`: ตรวจครบโดยไม่พบข้อผิดพลาดและไม่มี Preview ใหม่ ให้แสดง “ไม่พบ Confirmation ใหม่” และไม่แสดงการ์ด Preview ของรอบเก่า
- `syncStatus = NEW_DATA_FOUND`, `noNewData = false`: ค้นครบและมี Preview ใหม่จากอย่างน้อยหนึ่งชุด
- `syncStatus = COMPLETED_WITH_ERRORS`, `noNewData = null`: ยังมีไฟล์ขอรหัส/อ่านไม่ได้/เกิน limit หรือเมลตรวจไม่ได้ ให้แสดงข้อผิดพลาดนั้น ไม่อ้างว่าไม่มีข้อมูลใหม่แน่นอน
- ใช้รหัสไฟล์แนบ/hash/เลขเอกสาร ไม่ใช้ชื่อไฟล์อย่างเดียว เพราะชื่อเหมือนกันอาจเป็นคนละ Confirmation

## ยืนยันนำเข้า

```http
POST /api/v1/trades/import
Content-Type: application/json
Authorization: Bearer <token>
```

```json
{ "documentIds": ["00000000-0000-4000-8000-000000000001"] }
```

```json
{
  "results": [
    { "documentId": "00000000-0000-4000-8000-000000000001", "outcome": "IMPORTED", "transactionCount": 3 }
  ],
  "counts": { "imported": 1, "alreadyImported": 0, "failed": 0 }
}
```

ผลรายเอกสาร HTTP 200: IMPORTED, ALREADY_IMPORTED, NOT_FOUND (รวมของผู้อื่นโดยไม่เผยว่ามีอยู่), DOCUMENT_NUMBER_REQUIRED, DOCUMENT_DATA_INVALID ต้องตรวจ outcome ทุกตัว ไม่ใช้แค่ HTTP 200 เป็นความสำเร็จทั้งชุด หลัง SQL 008 ไม่ส่ง VALIDATION_REQUIRED จากคำเตือนแล้ว แต่ถ้ายังเห็นแปลว่ายังใช้ SQL รุ่นเดิม ผลรายเอกสารมี warnings และ hasWarnings เพิ่ม การมี warnings ไม่ได้แปลว่า import ล้มเหลว

## ยอดตาม PDF, ยอดคำนวณ และคำเตือนที่ไม่บล็อก

- หน้ารายละเอียดเอกสารยังแสดง display/summary ตาม PDF ไม่เปลี่ยนยอดให้ตรงสูตรของระบบ
- `calculation.investmentTotals` เป็นยอดรวมจาก **จำนวนเงินต่อรายการที่ parser อ่านได้** แยก BUY, SELL, SUBSCRIPTION, REDEMPTION, SWITCH_IN, SWITCH_OUT เป็น totalBuy/totalSell/totalSubscription/totalRedemption/totalSwitchIn/totalSwitchOut หน่วย THB หุ้นนอกใช้ totalAmount.thb ไม่รวม USD ตรง ๆ และไม่คูณราคาตลาดปัจจุบัน
- เก็บชุดนี้แยกไว้ใน Preview เอกสารใหม่ และอัปเดตในเอกสาร PREVIEW ก่อนนำเข้า เอกสารเก่าจะมี analysis เพิ่มใน response โดยไม่ต้องเปิด PDF ใหม่ เอกสารที่ IMPORTED ไปแล้วไม่ถูกเขียนทับยอด/รายการเก่าในการ GET
- ชุดนี้ใช้เป็นฐานสรุปประวัติการซื้อขายภายหลัง **ไม่ใช่ต้นทุนคงเหลือ/เงินฝากสุทธิ/มูลค่าพอร์ต** ยังไม่รวม logic ต้นทุนหรือการปรับยอดเมื่อขาย และอาจคลาดเคลื่อนหาก parser อ่านรายการไม่ครบ ต้องรักษาคำเตือนประกอบข้อมูล ไม่อ้างว่ายอดคำนวณถูกกว่า PDF
- คำเตือน TOTAL_BUY_MISMATCH และยอดรวมซื้อ/ขาย/กองทุนที่เทียบกับ summary จะเพิ่ม calculatedValue, pdfValue, difference (= calculatedValue - pdfValue), currency, field, blocking=false เช่น:

```json
{
  "code": "TOTAL_BUY_MISMATCH",
  "field": "totalBuy",
  "currency": "THB",
  "calculatedValue": 123,
  "pdfValue": 130,
  "difference": -7,
  "blocking": false,
  "message": "ยอดรวมจากรายการที่อ่านได้ไม่ตรงกับยอดสรุปใน PDF คุณยังสามารถยืนยันบันทึกได้"
}
```

Frontend แสดง “ระบบรวมรายการได้ 123 บาท แต่ยอดสรุปใน PDF คือ 130 บาท” แล้วให้กดบันทึกได้ ใช้ validation.blocksImport=false และ record.canImport แทนการบล็อกจาก validation.isValid เก็บ isValid=false ไว้บอกว่าผลตรวจไม่ตรงจริง ไม่เปลี่ยนเป็น true เพื่อซ่อนปัญหา หากค่าเป็น null ให้แสดงอ่านค่าไม่ได้ ไม่ใช้ 0 แทน

คำเตือนประเภทอื่นยังคง code และเพิ่ม blocking=false บางชนิดไม่มีค่าตัวเลขเปรียบเทียบ เช่นอ่าน summary ไม่ได้ จึงต้องแสดงข้อความตามประเภท กรณีไม่มีไฟล์/รหัสไม่ถูกต้อง/ไม่มีรายการให้ parse, ไม่มีเลขเอกสาร, ไม่ใช่เจ้าของ หรือ DB ล้มเหลวยังเป็นข้อผิดพลาด ไม่รับประกันว่าจะ import ได้ในกรณีข้อมูลเชิงโครงสร้างเสีย การกันซ้ำและ atomic ต่อเอกสารยังคงเดิม

ส่ง ID ซ้ำในคำขอเดียวประมวลผลครั้งเดียว เกิน 50 แบ่งชุดต่อเนื่อง Atomic เป็นรายเอกสาร ไม่ใช่ทั้ง batch ถ้า DB มีปัญหาระหว่างชุด เอกสารก่อนหน้าอาจ commit แล้ว ให้ retry IDs เดิมได้อย่างปลอดภัย ตัวที่นำเข้าแล้วไม่ทำซ้ำ orders/summary/userId ที่ client แทรกมาไม่ถูกนำไปใช้สร้างรายการ

## ประวัติและรายการลงทุน

List response: `{ "items": [], "offset": 0, "limit": 20, "hasMore": false, "nextOffset": null }` limit 1–100 เรียงวันสร้างใหม่ก่อน เอกสารมี metadata record รวม document/file ส่วน transaction มี id, document_id, order_index, order_id, transaction_type, asset_name, currency, units, unit_price, trade_date, settlement_date, details, created_at

details เก็บรายละเอียดต่อรายการตาม parser ทุก field รวมค่าธรรมเนียมและหลายสกุลเงิน อย่าสรุปว่า totalAmount ของหุ้นนอกเป็น THB ตัวเดียว เพราะเป็น object foreign/thb ยอดระดับเอกสารดู GET documents/:id

## การกันซ้ำและขอบเขต

ไฟล์ Monthly ที่ระบุจากชื่อแนบ Dime ได้ (`monthly_statement`, `Monthly Statement`) จะเก็บประวัติ IGNORED และไม่ดาวน์โหลด/ลองถอดรหัส จึงไม่ส่ง error รหัสผิดไปแสดงใน Preview กติกานี้ใช้กับ Gmail Sync ไม่ได้เปิดฟีเจอร์ Monthly หรือเก็บ PDF ไว้ใน DB หากชื่อทั่วไปจนระบุประเภทไม่ได้ ยังต้องใช้เนื้อหาหลังถอดรหัสในการจำแนก ส่วน Confirmation ที่รหัสผิดยัง retry ได้ตามปกติ

1. user + mailbox + Gmail message ID + attachment ID/part ID: ไฟล์เดิมข้ามการดาวน์โหลด attachment/parse และโหลดสถานะล่าสุดจาก DB
2. user + SHA-256 ของ bytes PDF: คนละเมลหรือ upload ใหม่แต่ไฟล์เดียวกัน ข้าม extraction/parser หลังได้ bytes แล้ว
3. user + ประเภท + เลขบัญชี + เลขใบกำกับภาษี (fallback เลขเอกสาร): bytes ต่างแต่เอกสารเดิมไม่สร้างรายการซ้ำ Rename ไม่เปลี่ยน identity
4. มี unique constraints และ RPC ที่ล็อกใน DB กันคำขอพร้อมกัน ไม่พึ่ง in-memory lock ของ Node อย่างเดียว

ยังตรวจรายการเมล/metadata เพื่อหาไฟล์ใหม่ ไม่ใช่ Gmail History API/checkpoint แบบ incremental สำหรับ inline attachment ที่ Gmail ส่ง bytes มากับ message full อยู่แล้ว จะประหยัดการ parse แต่ไม่รับประกันว่าจะไม่ได้รับ bytes ซ้ำเลย ไม่มีการเปลี่ยน read/unread/label ใน Gmail

Disconnect ลบ token แต่ไม่ลบเอกสาร รายการลงทุน หรือประวัติอ่าน ยังไม่มี endpoint ลบรายการลงทุน การนำเข้าเอกสารแก้ไขใช้เลขเดิมและการ reparse cache ด้วย parser รุ่นใหม่ยังไม่ได้ทำ ห้ามลบข้อมูลการเงินเองเพื่อแก้ cache โดยไม่มีแผน rollback ไฟล์ IGNORED มี parser_version สำหรับรองรับการเปิดชนิดใหม่ในอนาคต

## Error และการตรวจจริง

- 400 INVALID_DOCUMENT_IDS / INVALID_DOCUMENT_ID / INVALID_PAGINATION: ตรวจ input
- 401 UNAUTHORIZED: Supabase session ไม่ถูกต้อง
- 404 DOCUMENT_NOT_FOUND: ไม่พบหรือไม่ใช่เจ้าของ
- 503 INVESTMENT_STORAGE_UNAVAILABLE: ตรวจ migration 007/008 และ DB ไม่ใช่ PDF ผิด และ retry เมื่อระบบพร้อม

หลังรัน SQL ต้องทดลองบน Supabase จริง: upload → GET document → import → GET transactions → import ซ้ำ → sync เมลเดิม → จำนวนรายการต้องไม่เพิ่ม และบัญชีอื่นต้องมองไม่เห็น พร้อมทดสอบ concurrent requests/rollback เมื่อ insert ผิดพลาด Unit/HTTP tests ใช้ repository จำลอง ยังไม่ได้ยืนยัน SQL/RPC จริงแทนขั้นตอนนี้
