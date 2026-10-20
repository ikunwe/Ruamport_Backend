# Gmail sync → Dime PDF Preview (รอบทดสอบ)

อัปเดต: มีการเก็บ Preview/ประวัติอ่านและยืนยันนำเข้ารายการแล้ว ต้องรัน SQL 007 และใช้ [คู่มือนำเข้ารายการลงทุน](FRONTEND_INVESTMENT_IMPORT_GUIDE.md) ร่วมด้วย ALREADY_READ/ALREADY_IMPORTED เป็นสถานะปกติ ไม่ใช่ error

หลัง SQL 008 คำเตือน validation ไม่บล็อกการนำเข้าอีกต่อไป UI ใช้ record.canImport เปิดปุ่ม แสดงยอดตาม PDF และแสดง calculatedValue เทียบ pdfValue ในคำเตือนยอดรวม ส่วน calculation.investmentTotals เก็บยอดจากรายการแยกไว้ ห้ามเปลี่ยนยอด display ให้เท่ากับค่าคำนวณ และห้ามใช้ validation.isValid=false ปิดปุ่มบันทึก

## ขอบเขต

Monthly ที่ชื่อไฟล์ระบุได้ เช่น `Dime_monthly_statement_...pdf` จะถูกข้าม **ก่อนดาวน์โหลด/เปิด PDF** แม้ไม่ใส่รหัสหรือรหัสผิด ไม่ส่ง PASSWORD_REQUIRED/PASSWORD_INVALID หรือ Preview ของไฟล์นั้น และจำใน gmail_pdf_history เป็น IGNORED ไม่เก็บ bytes/รหัส เอกสารยังนับใน foundPdfCount ตามเดิม ไม่กรองทั้งอีเมลจาก subject เพื่อไม่ให้ Confirmation ที่แนบในเมลเดียวกันหาย หากชื่อถูกเปลี่ยนเป็นทั่วไปจนระบุ Monthly ไม่ได้ ยังต้องเปิดด้วยรหัสที่ถูกต้องเพื่อจำแนกจากเนื้อหา ไม่ซ่อน password error ของ Confirmation หรือไฟล์ที่ยังไม่ทราบชนิด

**Confirmation เท่านั้น:** รับหุ้นนอก (`DIMEOS`), หุ้นไทย (`DIMETH`) และกองทุน (`DIMEMF`) จากรหัสในเนื้อหา ไม่ใช้คำว่า Confirmation Note เพียงอย่างเดียว เพราะเอกสาร Dime Gold ก็อาจใช้หัวข้อนี้ เมื่อเปิดและจำแนก PDF ได้ว่าเป็น Gold/ประเภทที่ไม่รองรับ จะไม่ส่งรายการนั้นใน results ไม่ส่ง PARSE_FAILED ให้แสดง หากทั้งชุดเป็นเอกสารที่ไม่รองรับ results อาจว่างแต่ยังต้องโหลด nextCursor ต่อเมื่อ hasMore=true หากเป็น Confirmation ที่รองรับแต่ parser อ่านไม่ได้จริง ยังส่ง error ตามเดิม ไม่ปิดบังข้อผิดพลาดทุกประเภท ไฟล์ล็อกต้องใส่รหัสก่อนจึงจำแนกชนิดจากเนื้อหาได้

เชื่อม Gmail ครั้งแรกผ่านหน้าอนุญาตของ Google จากนั้นกดซิงค์ย้อนหลัง **ทั้งหมดตั้งแต่เมลแรกที่ยังมีอยู่ใน Gmail** (default `months: "all"`) เพื่อดึง PDF แนบจากอีเมล Dime แล้วส่งเข้า parser เดิม ยังเลือกย้อนหลัง 1 หรือ 2 เดือนได้เพื่อทดสอบ ค้นหาเฉพาะเมลตาม filter Dime เดิม ไม่ใช่ทุกเมลในบัญชี และไม่รวม Spam/Trash ตามค่าเริ่มต้น Gmail API ตอนนี้เก็บ Preview/ประวัติอ่านในฐานข้อมูลเพื่อลดการอ่านซ้ำ แต่ยังไม่ auto-import รายการลงทุนจนกดยืนยัน POST /trades/import ไม่เก็บเนื้อหาเมล/bytes PDF/รหัส ไม่ส่งเมล ไม่เปลี่ยนสถานะอ่านเมล และไม่ต้องตั้ง forwarding

รองรับ Gmail (`gmail.com` / `googlemail.com`) ก่อน ระบบเลือกช่องทางจากอีเมลของผู้ใช้ที่ Login อยู่ ไม่ใช่ให้ผู้ใช้เลือก provider เอง Outlook/Hotmail/Live ยังไม่เชื่อม Microsoft Graph ในรอบนี้ ให้แสดงว่ายังไม่รองรับและใช้ upload PDF เดิมได้ ห้ามเสนอปุ่มเชื่อม Gmail ให้ทุก provider โดยไม่ดู `supported`

Social Login ผ่าน Supabase กับการอนุญาตอ่าน Gmail เป็นคนละขั้นตอน แม้ Login ด้วย Google แล้วก็ยังต้องเชื่อม Gmail เพื่อให้สิทธิ์อ่านเมล หาก Login ด้วย Facebook แต่มีอีเมล Gmail ก็ใช้ flow นี้ได้ โดย Google account ที่อนุญาตต้องมีอีเมลตรงกับบัญชีในระบบ

## ลำดับหน้าจอ Frontend

1. Login ตาม flow เดิม แล้ว `GET /api/v1/mail/connection` พร้อม Supabase access token
2. ถ้า `supported=true` แต่ `connected=false` ให้แสดงปุ่ม “เชื่อมต่ออีเมล” พร้อมอธิบายว่าจะอ่านอีเมลและ PDF จาก Dime
3. กดปุ่ม → `POST /api/v1/mail/gmail/connect` → เปิด `authorizationUrl` ในหน้า browser ด้วยการเปลี่ยนหน้า (`window.location.assign`) Google จะแสดงบัญชีและหน้าอนุญาตสิทธิ์ ห้ามส่ง token ไปทาง URL
4. Google ส่งกลับ **Backend callback** `/api/v1/mail/gmail/callback` Backend ตรวจ state แบบใช้ครั้งเดียว, แลก code, ตรวจสิทธิ์และอีเมล แล้วเก็บ refresh token แบบเข้ารหัส
5. Backend redirect ไป `GMAIL_FRONTEND_RETURN_URL` เช่น `/mail/return?mailConnection=connected` หรือ `?mailConnection=error&code=MAIL_EMAIL_MISMATCH` Frontend ต้องมี route นี้อยู่จริง และคง Supabase session ให้เรียก API หลังกลับมาได้
6. หน้า return ต้องเรียก `GET /mail/connection` อีกครั้งเพื่อยืนยันสถานะจริง อย่าเชื่อ query string ว่าเชื่อมสำเร็จเอง
7. แสดงปุ่ม “ซิงค์ทั้งหมด” โดยส่ง months: "all" เป็นค่าเริ่มต้น (เลือก 1/2 เดือนได้หากต้องการ), ช่องรหัส PDF (ชนิด password ไม่เก็บใน localStorage) → `POST /mail/gmail/sync-preview`
8. แสดงผลแยกตาม PDF: READY / PASSWORD_REQUIRED / PASSWORD_INVALID / PARSE_FAILED / LIMIT_SKIPPED รวมถึง MAIL_READ_FAILED ที่เป็นข้อผิดพลาดระดับเมล ไฟล์หนึ่งอ่านไม่ได้ไม่ทำให้ทั้งชุดล้มเหลว Monthly ปิดชั่วคราว: เมื่อแยกชนิดจากข้อความได้ จะตัดออกจาก results ทั้งรายการ ไม่ส่ง SKIPPED หรือ error ของ Monthly ให้แสดง และยังอ่าน Confirmation อื่นต่อ หาก PDF ยังล็อกอยู่จะส่งสถานะขอรหัสก่อน เพราะยังไม่ทราบชนิดจากเนื้อหา เมื่อใส่รหัสถูกต้องและ retry แล้วตรวจพบ Monthly จึงจะตัดออก
9. หากผู้ใช้กด “ซิงค์ทั้งหมด” แล้ว `hasMore=true` Frontend ต้องเรียกชุดถัดไปอัตโนมัติทีละ request โดยส่ง `nextCursor` กับ `months` ค่าเดิมจน hasMore=false พร้อมอัปเดตข้อความ “กำลังค้นหา PDF… พบแล้ว N ไฟล์” จาก progress.foundPdfCount ทุกชุด ห้ามให้ Frontend สร้างหรือแก้ cursor และอย่าหยุดเมื่อ results ว่าง (อาจเป็นชุดที่มีแต่ Monthly) ให้มีปุ่มหยุดการโหลดเพิ่มเติมได้
10. ถ้าต้องใส่รหัสใหม่ ส่ง `retryCursor` ของชุดเดิมกับ `pdfPassword` และ `months` เดิม แล้ว **แทนที่ผลของชุดนั้น** ไม่ append ซ้ำ รหัสหนึ่งใช้กับทุก PDF ในชุด; ถ้าไฟล์ใช้รหัสต่างกันสามารถลองซ้ำด้วยรหัสอื่นและรวมผลตาม source identity ได้
11. หากต้องเปลี่ยนช่วงเวลา ให้เริ่มคำขอใหม่โดยไม่ส่ง cursor ผลซิงค์เป็น snapshot แต่ละครั้ง ไม่ใช่รายการที่นำเข้าจริง
12. ปุ่ม “ตัดการเชื่อมต่อ” → `DELETE /mail/gmail/connection` แล้วอัปเดตสถานะ

## Endpoint

ทุก endpoint ยกเว้น GET callback ต้องมี `Authorization: Bearer <supabase_access_token>` POST ใช้ JSON และ `Content-Type: application/json` URL ด้านล่างอยู่ใต้ `/api/v1`

| Method | Path | หน้าที่ |
|---|---|---|
| GET | `/mail/connection` | สถานะและช่องทางที่รองรับ ไม่ส่ง token |
| POST | `/mail/gmail/connect` | เริ่มขอสิทธิ์; body `{}`; ส่ง authorizationUrl และ expiresAt (10 นาที) |
| GET | `/mail/gmail/callback` | Google เรียกพร้อม code/state; ไม่ใช่ endpoint ที่ Frontend fetch |
| POST | `/mail/gmail/sync-preview` | ใช้ประวัติอ่าน/Preview เดิม หรืออ่านและเก็บ Preview ใหม่ ยังไม่ยืนยันนำเข้าลงทุน |
| DELETE | `/mail/gmail/connection` | ลบข้อมูลเชื่อมต่อในระบบ และลองเพิกถอนสิทธิ์ Google |

### สถานะการเชื่อมต่อ (ตัวอย่าง Gmail ที่เชื่อมแล้ว)

```json
{
  "emailDomain": "gmail.com",
  "channel": "GMAIL_API",
  "connectionProvider": "GOOGLE",
  "requiresMailConnection": true,
  "nextAction": "CONNECT_GOOGLE_MAIL",
  "supported": true,
  "connected": true,
  "connection": {
    "provider": "GOOGLE",
    "email": "user@gmail.com",
    "connectedAt": "2026-10-08T10:00:00.000Z"
  }
}
```

`nextAction` เป็นคำแนะนำช่องทางเดิมจาก email routing; หน้าเว็บต้องใช้ `connected` ตัดสินใจว่าจะโชว์ปุ่มเชื่อมหรือปุ่มซิงค์ ถ้ายังไม่เชื่อม `connection=null` ค่าที่ว่า connected หมายถึงมีการเชื่อมเก็บไว้ ไม่รับประกันว่าสิทธิ์ Google ยังใช้งานได้จนกว่าจะซิงค์

### Request ซิงค์

```json
{ "months": "all", "pdfPassword": "รหัสของ PDF" }
```

ไม่ส่ง `pdfPassword` ได้ โดยจะได้ผล PASSWORD_REQUIRED สำหรับไฟล์ล็อก ค่า months รับ "all" (default), ตัวเลข 1 หรือ 2 เท่านั้น ในโหมด all: range.start=null หมายถึงไม่มีขอบเขตวันที่เริ่ม และ end ล็อกไว้ ณ เวลาเริ่ม sync ส่วน 1/2 เดือนนับย้อนหลังจากเวลาเริ่ม ไม่ใช่เดือนปฏิทินเต็ม ใช้ช่วงเวลาเดียวกันตลอดการโหลดชุดถัดไป

Request หน้าถัดไป: `{ "months": "all", "cursor": "ค่าจาก nextCursor", "pdfPassword": "..." }`

Request อ่านชุดเดิมใหม่: `{ "months": "all", "cursor": "ค่าจาก retryCursor", "pdfPassword": "..." }`

Cursor เข้ารหัสและผูกกับผู้ใช้/ช่วงเวลาที่เลือก มีอายุ 1 ชั่วโมง; หมดอายุให้เริ่ม sync ใหม่ รหัส PDF ไม่อยู่ใน cursor และต้องส่งใหม่ถ้าต้องการใช้ ถ้าถือ cursor จากรอบ months=1/2 ต้องส่ง months ค่าเดิม ไม่สามารถเปลี่ยนเป็น all กลางรอบ

### Response ซิงค์

```json
{
  "mode": "PREVIEW_ONLY",
  "months": "all",
  "range": { "start": null, "end": "2026-10-08T10:00:00.000Z" },
  "scannedMessages": 1,
  "foundPdfCount": 1,
  "progress": {
    "scannedMessages": 1,
    "foundPdfCount": 1,
    "readyPdfCount": 0,
    "unreadableMessages": 0,
    "searchComplete": true,
    "countIsExact": true,
    "totalPdfCount": 1
  },
  "results": [
    {
      "source": {
        "messageId": "gmail-message-id",
        "attachmentId": "gmail-attachment-id",
        "partId": "1",
        "sender": "Dime <notification@dime.co.th>",
        "subject": "ตัวอย่างหัวข้อเมล",
        "receivedAt": "2026-10-01T00:00:00.000Z",
        "filename": "renamed.pdf"
      },
      "status": "PASSWORD_REQUIRED",
      "error": { "code": "PDF_PASSWORD_REQUIRED", "message": "This PDF requires a password" }
    }
  ],
  "hasMore": false,
  "nextCursor": null,
  "retryCursor": "opaque-encrypted-cursor",
  "counts": { "ready": 0, "failed": 1 }
}
```

หาก READY จะมี `preview` **เป็น response เดียวกับ endpoint upload เดิม** ได้แก่ file, document, orders, summary, calculation, validation สำหรับ Confirmation แทน `error` และมี `duplicateOf=null` หรือ source ของไฟล์แรกที่มี `document.deduplicationKey` เดียวกันในชุดนั้น รองรับเฉพาะ offshore confirmation, Thai stock confirmation และ mutual fund confirmation อ่านชนิดเอกสารจากเนื้อหา ไม่พึ่งชื่อไฟล์เดิม Monthly ปิดชั่วคราวและเก็บ parser ไว้พัฒนาในอนาคตเท่านั้น

ใช้ `messageId` ร่วมกับ `attachmentId` หรือ `partId` เป็น identity ของไฟล์ใน UI เพื่อไม่แสดงซ้ำเมื่อ retry; รองรับ preview ต่างชนิดโดยดู `preview.document.type` ไม่ใช่ filename ต้องแสดงคำเตือน `preview.validation` จาก parser ด้วย ไม่ถือว่า READY รับรองความถูกต้องทางบัญชี

สำหรับหุ้นนอก ใช้ `preview.display` เป็นยอดแสดงตาม PDF โดยเฉพาะ `display.totalFeeIncludeVatAfterDiscount` และ `display.totalFeesAndTaxes` ซึ่งรวมจากยอดสุทธิ/VAT/ภาษีที่เอกสารระบุ ไม่ใช้ `preview.calculation` เป็นยอดจ่ายจริงหรือ fallback หากยอด PDF เป็น null และอย่าแปลง null เป็น 0 ยอดคำนวณเดิมยังอยู่ใน `calculation` ส่วน `FEE_AFTER_DISCOUNT_MISMATCH` อยู่ใน `diagnostics.validation` สำหรับตรวจสอบภายในเท่านั้น ห้ามนำ diagnostics ไปแสดงรบกวนผู้ใช้ คำเตือนชนิดอื่นยังอยู่ใน `validation` ตามเดิม หุ้นไทย/กองทุนใช้ summary ตาม schema เดิม

`scannedMessages` เป็นจำนวนเมลที่ตรวจในชุด ไม่ใช่จำนวน PDF; หนึ่งเมลมีหลาย PDF ได้ และชุดอาจว่างแม้ `hasMore=true` อย่าหยุดโหลดเพียงเพราะ results ว่าง `counts.failed` ไม่รวม READY, ALREADY_READ, ALREADY_IMPORTED และมี counts.alreadyRead/counts.alreadyImported เพิ่ม ALREADY_READ/ALREADY_IMPORTED ส่งเพียง source/record ไม่ส่ง Preview เก่าอีก เพิ่มการ์ดเฉพาะ READY เท่านั้น และเริ่ม sync ใหม่ต้องล้างการ์ดรอบก่อนใน UI

รอบใหม่มี syncStatus/hasNewData/noNewData: เมื่อยังมี hasMore=true เป็น SCANNING; เมื่อครบและไม่มี READY ใหม่หรือข้อผิดพลาดเป็น NO_NEW_DATA/noNewData=true ให้แสดง “ไม่พบ Confirmation ใหม่”; หากมี error ต้องเป็น COMPLETED_WITH_ERRORS/noNewData=null อย่าแสดงว่าไม่มีข้อมูลใหม่แน่นอน รายละเอียดในคู่มือนำเข้า

### จำนวนไฟล์และข้อความระหว่างโหลด (ใหม่)

- `foundPdfCount`: จำนวน attachment PDF ที่พบในชุดนี้ ตรวจจาก metadata ก่อนเปิด/parse นับไฟล์ล็อก ไฟล์อ่านไม่ได้ และ Monthly/Gold/ประเภทที่ไม่รองรับซึ่งจะถูกซ่อนด้วย ไม่ใช่จำนวน Preview Confirmation, จำนวนรายการหุ้น หรือจำนวนเอกสารไม่ซ้ำ หากต้องการจำนวน Confirmation ที่อ่านสำเร็จให้ใช้ progress.readyPdfCount
- `progress.foundPdfCount`: จำนวน PDF ที่พบสะสมตลอดลำดับ cursor นี้ Frontend ใช้ค่าโดยตรง **ไม่ต้องบวกเพิ่มเอง** โดยเฉพาะเวลา retry ชุดเดิม
- `progress.readyPdfCount`: จำนวน Preview Confirmation ที่อ่านสำเร็จสะสม (อาจมี duplicateOf) ไม่รวม Monthly; แสดงแยกได้ว่า “พบ PDF N ไฟล์ / อ่าน Confirmation สำเร็จ M ไฟล์”
- ขณะ hasMore=true ให้ใช้ “พบแล้ว N ไฟล์” ยังไม่ทราบยอดทั้งหมด ห้ามใช้ Gmail resultSizeEstimate เป็นจำนวน PDF หรือทำเปอร์เซ็นต์โดยเดายอดรวม
- เมื่อ progress.searchComplete=true และ countIsExact=true จึงใช้ totalPdfCount เป็นยอดรวม PDF ที่ค้นพบจริงในขอบเขตนั้น การค้นครบไม่ใช่การ parse สำเร็จทุกไฟล์
- ถ้ามี unreadableMessages>0 แม้โหลดถึงชุดสุดท้าย totalPdfCount ยังเป็น null และ countIsExact=false ให้แสดง “ตรวจพบอย่างน้อย N ไฟล์ มีบางอีเมลที่ตรวจไม่ได้” แทนคำว่า “ทั้งหมด N ไฟล์”
- แต่ละ response อัปเดตหลังจบชุด ไม่มี SSE/WebSocket และไม่มีจำนวนไฟล์ realtime ระหว่าง request แรกกำลังทำงาน ให้ขึ้น “กำลังค้นหา PDF…” ก่อน แล้วค่อยอัปเดตเมื่อแต่ละชุดตอบกลับ
- Retry ชุดเดิมใช้ counter ก่อนชุดนั้นใน retryCursor จึงไม่บวกไฟล์ซ้ำ; หลัง retry ให้ใช้ nextCursor จาก response ใหม่ในการเดินหน้าต่อ เพื่อให้ยอดอ่านสำเร็จสะสมถูกต้อง อย่านำ retry หน้าเก่ามาทับ progress หน้าล่าสุด หากไม่ได้เดินหน้าชุดต่อไปใหม่
- end ล็อกช่วงเวลา ไม่ใช่ snapshot กล่องเมลแบบ immutable หากมีการลบ/ย้ายเมลระหว่างซิงค์ ผลที่พบอาจเปลี่ยนได้ ไฟล์เกิน resource limit ยังพบและนับแต่ไม่รับประกันว่า parse ได้ในรอบนั้น

## ข้อจำกัดและความปลอดภัย

- ชุดละ 10 เมล, อ่านไม่เกิน 20 PDF, 10 MB ต่อไฟล์, 25 MB รวมต่อชุด ไฟล์เกินขอบเขตเป็น LIMIT_SKIPPED; สามารถดาวน์โหลดแล้วใช้ upload เดิมได้หากไฟล์ไม่เกิน limit ของ upload
- ตรวจช่วงเวลาจาก **วันที่รับอีเมล** ไม่ใช่วันซื้อขายใน PDF จึงอาจได้เอกสารของช่วงซื้อขายที่แตกต่างกัน
- อ่านเฉพาะ PDF ที่เป็น attachment (รวม nested MIME) ไม่ตามลิงก์ดาวน์โหลดภายนอกในอีเมล ไฟล์สแกน/เอกสารใหม่ที่ parser ไม่รองรับอาจอ่านไม่ได้
- ค้นหาจากโดเมนผู้ส่ง `DIME_MAIL_SENDER_DOMAINS` แล้วตรวจ From ซ้ำ ไม่ใช้ชื่อแสดงผู้ส่งว่า Dime เพียงอย่างเดียว; โดเมนเป็น filter ไม่ใช่การรับรองความแท้ของเอกสาร
- หลัง SQL 007 เก็บผล Preview และการเชื่อมโยงไฟล์แนบใน DB แต่ไม่เก็บรหัส PDF, เนื้อหาอีเมล หรือ bytes PDF Frontend ไม่ควร log ข้อมูลการเงินโดยไม่จำเป็น
- ป้องกันซ้ำข้าม sync/upload/import ด้วย history/hash/เลขเอกสารแล้ว ดูคู่มือนำเข้ารายการลงทุน duplicateOf ยังเป็นตัวช่วยภายในชุด แต่ record.id เป็น identity เอกสารที่เก็บจริง
- ส่ง sync ผู้ใช้ละหนึ่ง request ต่อ process ในเวลาเดียวกัน; หากมีหลาย backend instances ต้องเพิ่ม distributed lock/rate limiting ก่อนใช้งานจริง
- การซิงค์เป็น synchronous request ให้แสดง loading และตั้ง timeout Frontend/proxy ให้เหมาะสม เมื่อเมล/PDF มากควรเปลี่ยนเป็น background job ภายหลัง
- connected ไม่ได้หมายความว่าจะซิงค์อัตโนมัติ; ต้องกดปุ่มเอง รอบนี้ยังไม่มี scheduler
- DELETE ส่ง `{ "connected": false, "googleRevoked": true/false }` หาก false ข้อมูล token ในระบบถูกลบแล้ว แต่ควรไปลบสิทธิ์แอปใน Google Account ด้วย

## Error ที่ Frontend ต้องรองรับ

ข้อผิดพลาดทั้ง request ใช้ `{ "error": { "code": "...", "message": "..." } }` เช่นเดิม

| HTTP | Code | การแสดงผล |
|---|---|---|
| 400 | INVALID_SYNC_MONTHS / INVALID_PDF_PASSWORD / INVALID_SYNC_REQUEST | ตรวจ input |
| 400 | INVALID_MAIL_CURSOR | เริ่ม sync ใหม่ |
| 401 | UNAUTHORIZED | ต่ออายุ Supabase session หรือ Login ใหม่ |
| 401 | MAIL_RECONNECT_REQUIRED | ให้เชื่อม Gmail ใหม่ ไม่ใช่ Login เว็บไซต์ใหม่อย่างเดียว |
| 403 | GMAIL_ACCESS_DENIED | ตรวจ Gmail API/สิทธิ์อ่านเมลกับผู้ดูแล |
| 409 | MAIL_NOT_CONNECTED | ให้เชื่อมอีเมลก่อน |
| 409 | MAIL_SYNC_BUSY | รอ request เดิมเสร็จ |
| 422 | MAIL_PROVIDER_UNSUPPORTED | รอบนี้ Gmail เท่านั้น ใช้ upload PDF แทน |
| 429 | GMAIL_RATE_LIMITED | รอแล้วลองใหม่ |
| 502 | GMAIL_UNAVAILABLE / GMAIL_REQUEST_FAILED | Google มีปัญหา ลองใหม่ |
| 503 | MAIL_CONFIG_MISSING / MAIL_STORAGE_UNAVAILABLE / MAIL_TOKEN_UNREADABLE | ผู้ดูแลตรวจ env, migration, key; ไม่ใช่รหัส PDF ผิด |

Callback ส่ง error ผ่าน query `code`: MAIL_OAUTH_STATE_INVALID (expired/replay), MAIL_CONSENT_DENIED, MAIL_OAUTH_CODE_INVALID, MAIL_PERMISSION_REQUIRED, MAIL_EMAIL_MISMATCH หรือข้อผิดพลาดบริการข้างต้น ห้ามแสดง raw Google response/token

## สิ่งที่ต้องทำภายนอกโค้ดก่อนทดสอบจริง

1. Supabase SQL Editor: รัน `supabase/migrations/006_gmail_preview_connections.sql` หลัง 001–005 ไม่ต้องลบตาราง Auth เดิม เพิ่ม mail_connections/mail_oauth_states เปิด RLS และให้ service_role เท่านั้น ไม่มี policy อ่านจาก client
2. Google Cloud: เปิด Gmail API ใน project ที่เลือก สร้าง OAuth client ชนิด Web application สำหรับ mail connection (แนะนำแยก client จาก Login เพื่อแยกการเพิกถอนสิทธิ์)
3. ตั้ง OAuth consent screen/audience และ test users ที่จะทดสอบ พร้อม scope `https://www.googleapis.com/auth/gmail.readonly` สิทธิ์ Login เดิมอย่างเดียวอ่านเมลไม่ได้
4. Authorized redirect URI ของ Google client ต้องตรง `GMAIL_REDIRECT_URI` ทุกตัวอักษร เช่น `http://localhost:3000/api/v1/mail/gmail/callback` นี่คือ Backend callback ไม่ใช่ Supabase callback และไม่ใช่ Frontend return URL
5. ใส่ GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REDIRECT_URI, GMAIL_FRONTEND_RETURN_URL, MAIL_TOKEN_ENCRYPTION_KEY และ DIME_MAIL_SENDER_DOMAINS ใน `.env` ตาม `.env.example` ห้ามเอา secret/key ไปไว้ Frontend
6. สร้าง encryption key ครั้งเดียวด้วย `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"` เก็บ key ไว้ใน secret storage; อย่าสร้างใหม่ทุก restart
7. เปิดอีเมล Dime จริงดู From ว่าเป็นโดเมนใด ปรับ DIME_MAIL_SENDER_DOMAINS ให้ตรง หากไม่พบ PDF ตรวจ filter และช่วงเวลาก่อน อย่าแก้ไปอ่านทุกเมลโดยไม่จำเป็น
8. Restart Backend และสร้าง Frontend `/mail/return` ทดสอบ connect → sync 1 เดือน → ใส่รหัส → retry → pagination → disconnect ด้วยบัญชี test user

ก่อน public launch ต้องทบทวน Google verification ของ Gmail read-only ซึ่งเป็น restricted scope และข้อกำหนดการใช้ข้อมูล รวมถึง production HTTPS, secret management และ rate limiting ห้ามถือว่าแค่สร้าง OAuth client แล้วพร้อมเปิดให้ทุกคนใช้

อ้างอิงทางการ: [Google OAuth web server](https://developers.google.com/identity/protocols/oauth2/web-server), [Gmail scopes](https://developers.google.com/workspace/gmail/api/auth/scopes), [ค้นหาเมลและ pagination](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list), [อ่าน attachment](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages.attachments/get)
