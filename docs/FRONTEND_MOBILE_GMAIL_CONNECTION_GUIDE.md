# Gmail connection: เว็บและ Android Flutter

## Flow

```text
Flutter ส่ง POST /mail/gmail/connect {"client":"mobile"} พร้อม Bearer token
  → Backend ตรวจผู้ใช้ สร้าง state + PKCE และผูก client แบบเข้ารหัส
  → Flutter เปิด authorizationUrl ในเบราว์เซอร์ภายนอก
  → ผู้ใช้อนุญาต Gmail read-only
  → Google กลับเข้า GMAIL_REDIRECT_URI ของ Backend
  → Backend consume state ครั้งเดียว แลก code ตรวจอีเมล และเก็บ refresh token แบบเข้ารหัส
  → HTTP 303 กลับ io.ruamport.mobile://mail/return พร้อมผลลัพธ์ที่ควบคุมไว้
  → Android เปิด Flutter → Flutter เรียก GET /mail/connection พร้อม token ปัจจุบัน
  → แสดงสถานะที่ Backend ยืนยัน แล้วผู้ใช้เริ่ม sync-preview ตามเดิม
```

การล็อกอินผ่าน Supabase กับการอนุญาตอ่าน Gmail เป็นคนละ flow ไม่มีการส่ง Gmail access/refresh token, Google authorization code, PKCE verifier หรือรหัส PDF กลับเข้าแอปผ่าน deep link

## API ที่เปลี่ยน

`POST /api/v1/mail/gmail/connect` ยังต้องใช้ Bearer access token รับ JSON:

```json
{"client":"mobile"}
```

เว็บใช้ `{"client":"web"}` หรือ `{}`/ไม่มี body แบบเดิมได้ Response ยังเป็น `{authorizationUrl, expiresAt}` ไม่ต้องเปลี่ยน contract ของ sync/import

- รองรับเฉพาะ `web` และ `mobile` ถ้าส่ง client อื่น/returnUrl/userId/field ที่ไม่รองรับ ตอบ 400 `INVALID_MAIL_CLIENT` รวม JSON body `null`, array, scalar และ JSON ผิดรูปแบบที่ connect endpoint โดยไม่สร้าง state หรือส่งเนื้อหา request ดิบกลับใน error
- Backend เลือกปลายทางเอง: เว็บใช้ `GMAIL_FRONTEND_RETURN_URL` เดิม; มือถือใช้ `io.ruamport.mobile://mail/return` ที่กำหนดในโค้ด
- ปลายทางผูกกับ state ที่เข้ารหัส ไม่อ่าน `client`, `redirectTo` หรือ URL จาก callback query เพื่อเลือกปลายทาง
- Mobile state ที่ถูกต้อง: สำเร็จ → `?mailConnection=connected`; ปฏิเสธ/ล้มเหลว → `?mailConnection=error&code=MAIL_CONSENT_DENIED` หรือรหัส error ที่ควบคุมไว้
- state ไม่ถูกต้อง/หมดอายุ/ใช้ซ้ำ/ถอดรหัสไม่ได้ ไม่เชื่อ query ว่ามาจากมือถือ จึงใช้ error return ของเว็บตามเดิม หากอยู่ Android ให้กลับแอปแล้วเริ่มเชื่อมใหม่

## Flutter ที่ปรับแล้ว

- ImportApi ส่ง client ตาม platform (`web` บน Flutter Web; `mobile` บน native)
- AndroidManifest รับเฉพาะ scheme/host/path `io.ruamport.mobile://mail/return` แยกจาก `io.ruamport.mobile://auth/callback` ของ Supabase login
- app_links รับทั้งลิงก์ตอนแอปเปิดอยู่และตอนเปิดแอปขึ้นมาใหม่ เก็บ navigation hint ใน RAM รอ Dashboard พร้อม ไม่เก็บผลนี้เป็นหลักฐานว่าเชื่อมต่อแล้ว
- ถ้า sheet Sync เปิดอยู่ให้อัปเดต sheet เดิม ถ้าเปิดแอปใหม่ให้เปิด sheet หลัง session/profile พร้อม ไม่ซ้อน sheet ซ้ำ
- ทุกกรณีต้องเรียก authenticated `GET /mail/connection` เพื่อยืนยัน แม้ลิงก์จะเขียนว่า connected; ไม่เริ่มอ่านเมล/ซิงค์/นำเข้าเองจาก deep link
- ผล error ใช้ข้อความจาก controlled code; callback ของ Gmail ไม่ผ่านตัวแลก Supabase OAuth code และไม่เปลี่ยน session login
- กรณีผู้ใช้กด Back กลับจากเบราว์เซอร์ยังมี lifecycle observer ตรวจสถานะจริงและปลดปุ่มเชื่อมต่อ ไม่ถือว่า Back แปลว่าอนุญาตแล้ว

รอบนี้รองรับ callback Android; iOS ต้องเพิ่ม URL scheme ใน platform config ก่อนใช้งานจริง

## ทดสอบ Local บน emulator-5554

Backend `.env` ใช้ของเดิม เช่น:

```dotenv
GMAIL_REDIRECT_URI=http://localhost:3000/api/v1/mail/gmail/callback
GMAIL_FRONTEND_RETURN_URL=http://localhost:4200/mail/return
```

**อย่าเปลี่ยน GMAIL_FRONTEND_RETURN_URL เป็น deep link** เพราะเว็บยังใช้อยู่ และ Google callback ต้องกลับ Backend ไม่ใช่กลับแอปโดยตรง ไม่ต้องเพิ่ม deep link ของ Gmail นี้ใน Supabase Redirect URLs; URL ของ Supabase login เป็นคนละส่วน

Google Cloud OAuth client ต้องอนุญาต GMAIL_REDIRECT_URI ที่ตรงกันทุกตัวอักษร หาก URL เดิมลงทะเบียนไว้แล้วไม่ต้องสร้าง OAuth client ใหม่

1. Restart Backend (`npm run dev`)
2. เปิด Emulator แล้วเชื่อม reverse port เพื่อให้ Chrome ใน Emulator เข้าถึง callback localhost ของคอมได้:

```powershell
adb -s emulator-5554 reverse tcp:3000 tcp:3000
adb -s emulator-5554 reverse --list
```

ถ้า adb ไม่อยู่ใน PATH ใช้ตำแหน่งของ Android SDK:

```powershell
& "$env:LOCALAPPDATA/Android/sdk/platform-tools/adb.exe" -s emulator-5554 reverse tcp:3000 tcp:3000
```

3. หยุด Flutter แล้ว build/run ใหม่เพื่อรวม Manifest และ app_links plugin:

```sh
flutter pub get
flutter run -d emulator-5554
```

4. ใน Chrome ของ Emulator ลองเปิด `http://localhost:3000/api/v1/health` ให้ตอบ status ok ก่อนกดเชื่อมเมล แอปยังใช้ API `http://10.0.2.2:3000/api/v1` ได้ตามเดิม ส่วน localhost ของเบราว์เซอร์ใช้ reverse port
5. Login → Sync → เชื่อม Gmail → อนุญาตบัญชีอีเมลเดียวกับผู้ใช้ → กลับแอป → ตรวจสถานะ connected → เลือกช่วง/รหัส PDF แล้วซิงค์

Reverse port เป็นการตั้งค่าสำหรับเครื่องทดสอบ อาจต้องทำใหม่หลังปิด Emulator/adb ใน production ใช้ Backend callback HTTPS ที่มือถือเข้าถึงได้ ไม่ใช้ localhost/adb และตรวจนโยบาย Google OAuth/Gmail ของแอปตามเดิม

Android reference: [เข้าถึง local server และ adb reverse](https://developer.android.com/develop/ui/views/layout/webapps/access-local-server). App links reference: [app_links](https://pub.dev/packages/app_links).

## Database และการ deploy

ไม่ต้องเพิ่ม SQL หรือ env ใหม่ ข้อมูล client ถูกบรรจุใน encrypted JSON ภายใน `mail_oauth_states.verifier_encrypted` เดิม อ่าน pending states แบบเก่าที่เก็บ verifier อย่างเดียวได้ โดยถือว่าเป็นเว็บ State ยังมีอายุ 10 นาทีและถูก consume แบบ atomic ตามเดิม ผู้ใช้ที่เชื่อมแล้วใช้ connection เดิมต่อได้

Deploy Backend ที่รองรับ client ก่อน Flutter ใหม่ และ rebuild APK หาก rollback Backend ระหว่างมี pending authorization แบบใหม่ ให้ผู้ใช้เริ่มเชื่อมใหม่ ไม่มีการแก้ PDF, parser, credentials ของ Supabase login หรือรายการลงทุน

### Pending state เมื่อเปิดเว็บและมือถือสลับกัน

พฤติกรรมเดิมของ repository คือเมื่อเริ่ม connect จะล้าง state หมดอายุ แล้วลบ pending states ของ **ผู้ใช้คนนั้น** ก่อนสร้างคำขอใหม่ ไม่ลบ pending ที่ยังไม่หมดอายุของผู้ใช้อื่น การเริ่มเชื่อมใหม่ไม่ลบ connection ที่เชื่อมสำเร็จแล้ว

ตัวอย่างการเริ่มตามลำดับ: ผู้ใช้ A เริ่มจาก Web แล้วเริ่ม Mobile ก่อน Web จบ → pending Web เดิมถูกยกเลิก หาก Google กลับมาด้วย state เก่าจะได้ `MAIL_OAUTH_STATE_INVALID` และ safe web error fallback ส่วนคำขอ Mobile ล่าสุดยังใช้ได้และกลับ deep link ตาม state ของตัวเอง ผู้ใช้ B ไม่ได้รับผลกระทบ

Frontend ควรปิดปุ่มเชื่อมซ้ำขณะรออนุญาต และหากเริ่มใหม่จากอีกอุปกรณ์ ให้ดำเนินการต่อจากคำขอล่าสุดที่เริ่มสำเร็จ ไม่พยายามใช้ state เก่า ไม่ retry POST connect อัตโนมัติ หากมี state เก่าค้างให้กลับแอปและกดเชื่อมใหม่

ข้อจำกัดเดิม: cleanup กับ insert ใน `saveState` เป็นคนละคำสั่ง จึงไม่ได้รับประกันลำดับ latest-wins สำหรับ **การเริ่ม connect พร้อมกันจริง ๆ** หลายเครื่อง รอบนี้คงพฤติกรรมเดิม ไม่เพิ่ม transaction/lock/migration ส่วน **callback พร้อมกันของ state เดียวกัน** ใช้ DELETE RETURNING แบบ atomic จึง consume ได้ครั้งเดียว เป็นคนละเรื่องกับการเริ่ม connect หลายคำขอ

## การตรวจสอบ

- Backend tests: mobile/web/legacy state, PKCE challenge, owner binding, replay/expiry, deny/provider failure, controlled 303/no-store/no-referrer, reject arbitrary destinations
- Flutter tests: exact callback parsing, cold pending inbox, consume once, native connect body, status re-fetch ป้องกัน fake connected link และ auth/import/UI regression
- Live consent และการอ่านเมลจริงต้องทดสอบด้วยบัญชีเจ้าของผ่าน Emulator; automated tests ไม่ใช้ Gmail ของผู้ใช้

รัน regression ของ contract โดยเฉพาะ:

```sh
node --test test/mail-callback-contract.test.js test/mail.repository.test.js test/mail.test.js test/mail.routes.test.js test/health.test.js
npm test
```

ชุด contract ใช้ HTTP server + service/router/error handler จริงกับ mock provider/repository ตรวจ body null ผ่าน strict JSON parser, mobile deny/email/scope/provider/storage errors, callback พร้อมกัน (หนึ่ง exchange/หนึ่ง write), status/disconnect แยก owner, sequential pending replacement และ legacy state ส่วน repository tests ตรวจ query ของโค้ดจริงว่าผูก user_id และ consume ด้วย DELETE RETURNING ครั้งเดียว Tests เหล่านี้ไม่ได้เป็น stress test บน Supabase/PostgreSQL หลาย connection จริง และไม่ได้ยืนยัน live consent บน Android
