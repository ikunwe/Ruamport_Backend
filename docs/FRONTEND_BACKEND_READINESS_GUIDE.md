# Frontend: รอ Backend พร้อมและ retry GET เมื่อเชื่อมต่อไม่ได้

เอกสารนี้เป็นแนวทางให้ฝั่ง Frontend นำไป implement ยังไม่ได้เปลี่ยน runtime ของ Frontend หรือ Backend ไม่ต้องเพิ่ม SQL หรือ `.env` ใหม่

## Health endpoint ที่มีอยู่แล้ว

```http
GET http://localhost:3000/api/v1/health
```

ไม่ต้องใช้ access token และตอบ HTTP 200:

```json
{
  "status": "ok",
  "service": "portfolio-api",
  "timestamp": "2026-10-29T11:00:00.000Z"
}
```

`timestamp` เป็นเวลาที่ตอบจริง ตัวอย่างด้านบนไม่ใช่ค่าคงที่ ให้ถือว่าพร้อมเมื่อ HTTP 200 และ body มี `status === 'ok'` กับ `service === 'portfolio-api'` เท่านั้น ป้องกันการรับหน้า HTML หรือคำตอบของ service อื่นเป็น health ที่สำเร็จ

Health ยืนยันว่า HTTP Backend ตอบได้ ไม่ได้ตรวจ Supabase, session, Finnhub, Yahoo, SEC หรือความครบถ้วนของ cache/API ภายนอก หลัง health ผ่าน API ธุรกิจยังอาจตอบ 401/503/ข้อมูล INCOMPLETE ได้ตามเดิม

ใช้ `environment.backendHealthUrl` และ `environment.apiUrl` ที่กำหนดไว้ ตรวจว่าเป็น origin เดียวกัน ห้ามเรียก health ของ localhost ใน production และไม่เลือกสลับ localhost/127.0.0.1 เองเพื่อหลบ error หรือ CORS

## นโยบายเวลารอและจำนวนครั้ง

| รายการ | ข้อกำหนดเริ่มต้น |
| --- | --- |
| Health ต่อครั้ง | timeout 1,500 ms และยกเลิก network request เมื่อหมดเวลา |
| Health ต่อรอบ | รวมไม่เกิน 4 attempts: ครั้งแรก + ลองเพิ่ม 3 ครั้ง |
| เว้นระหว่าง health | 500, 1,000, 2,000 ms ตามลำดับ |
| เวลารวมของ health ต่อรอบ | ไม่เกิน 10 วินาที รวมเวลารอคิว/หน่วงและ request; หยุดทันทีเมื่อครบ deadline |
| สถานะ READY | ใช้ร่วมกันชั่วคราวไม่เกิน 5 วินาทีต่อ Backend origin |
| Retry API ธุรกิจ | เฉพาะ GET ที่เข้าเกณฑ์ รวมไม่เกิน 3 attempts: ครั้งแรก + retry 2 ครั้ง |
| เว้นก่อน retry GET | 500 แล้ว 1,500 ms; ไม่มี retry รอบที่สามเพิ่มเติม |
| Timeout API ธุรกิจ | ใช้ของ endpoint เดิม; Analytics ยังคงมี deadline รวม 180 วินาที |

Deadline รวมของ API ธุรกิจต้องครอบตั้งแต่เริ่มรอ health จนถึง attempt สุดท้าย ไม่เริ่มนับใหม่ทุก retry เช่น Analytics ไม่ใช่ 180 วินาที × 3 ทุก health/delay/retry ต้องถูกตัดด้วยเวลาที่เหลือของคำขอนั้น

Health ที่ timeout/เชื่อมต่อไม่ได้ลองได้ตามจำนวนข้างต้น หากมี HTTP response ที่ไม่ใช่ 200 หรือ body ไม่ตรง contract ให้จบรอบและแสดงว่าบริการยังไม่พร้อม ไม่ใช้ generic retry ไปวน 401/403/404/429/5xx

## Flow การรอพร้อม

1. ก่อนส่ง API ไป Backend ครั้งแรก เรียก `BackendReadinessService.ensureReady()` ถ้ามี READY อายุไม่เกิน 5 วินาทีใช้สถานะนั้นได้
2. ถ้าไม่มี READY ให้รอ health ตามขอบเขตด้านบนก่อนส่งคำขอจริง ทุก component ใช้ health flight เดียวกันต่อ origin (`single-flight`) ไม่ให้ Dashboard, login, Analytics และ holdings ต่างคนต่างยิง health
3. เมื่อพร้อม จึงส่งคำขอจริงผ่าน auth interceptor เดิม พร้อมตรวจ session ปัจจุบัน ห้ามดึง token เก่ามาแช่ไว้ตั้งแต่ก่อนรอ health
4. หาก health ไม่พร้อมตาม deadline ให้จบคำขอด้วย error ของ readiness เช่น `BackendNotReadyError` พร้อม UI ลองใหม่ ไม่สร้าง `HttpErrorResponse` 401/503 ปลอม และไม่ส่งคำขอจริงต่อ
5. เมื่อผู้ใช้กดลองใหม่ ค่อยเริ่ม health รอบใหม่ ไม่รัน polling ไม่จำกัดอยู่เบื้องหลัง

ใช้ readiness gate กับ API ของ Backend ทั้ง GET/POST/PATCH/PUT/DELETE ได้ แต่การรอ health **ไม่ใช่สิทธิ์ให้ retry คำขอที่ส่งไปแล้ว** โดยเฉพาะการ login/import/upload/save

Health ต้อง bypass readiness gate และ network retry interceptor ของตัวเอง ป้องกัน recursion อีกทั้ง bypass auth interceptor: ไม่ขอ session, ไม่แนบ Authorization และไม่พาไปหน้า login จากผล health ใช้ HttpClient ที่สร้างจาก `HttpBackend` หรือ fetch แยกสำหรับ health ได้ โดยตั้ง `cache: 'no-store'`/HTTP no-cache ที่เหมาะสมและไม่เก็บผล health ลง response cache/service worker ห้ามมี token หรือข้อมูลผู้ใช้ใน health request

สถานะ READY เป็นเพียงช่วงสั้นสำหรับลด health ซ้ำ ไม่รับประกันว่าคำขอถัดไปจะเชื่อมต่อสำเร็จ ถ้าคำขอจริงเกิด network error ให้ invalidate READY ทันที และเช็กใหม่ก่อน retry ที่ได้รับอนุญาต

## GET แบบไหน retry ได้

ใช้เฉพาะ GET ไป Backend origin และ path ใต้ `environment.apiUrl` ที่ระบุเป็น read-only ของระบบ เช่น:

- `/auth/me`
- `/trades/holdings`, `/trades/documents`, `/trades/documents/:id`, `/trades/transactions`
- `/trades/portfolio-history`, `/trades/analytics/performance`, `/trades/analytics/win-rate`
- `/trades/exchange-rate`, `/trades/market-indices`, `/trades/stocks/:symbol/news`

แนะนำ allowlist หรือ HttpContext opt-in สำหรับ GET ที่ตรวจแล้ว ห้ามอาศัยเพียงชื่อ method ไป retry OAuth callback, token exchange, mail sync หรือ endpoint ภายนอก ต้องเทียบ parsed URL origin และขอบเขต path จริง ไม่ใช้ `startsWith` ที่ยอมรับ hostname/path คล้ายกัน

ใน Angular ใช้ `HttpErrorResponse.status === 0` เป็นสัญญาณ network error ที่ลองใหม่ได้ **เมื่อ** ไม่ใช่การยกเลิก/หมด deadline ของแอป และอุปกรณ์ไม่ได้ระบุว่า offline หาก offline ให้หยุดและรอให้ผู้ใช้ลองใหม่หลังเชื่อมต่อ ไม่ต้องใช้โควตา retry ทั้งหมด

Browser ไม่เปิดเผย `ERR_CONNECTION_REFUSED` ให้ interceptor แยกจาก CORS/DNS/TLS ได้แน่นอน จึงห้ามแสดงวินิจฉัยว่า Backend ปิดจาก status 0 อย่างเดียว กรณี CORS/TLS ผิดจะยังคงล้มเหลวหลังลองแบบจำกัด ต้องแก้การตั้งค่า ไม่ปิด security และไม่ใช้ `mode: 'no-cors'`

ห้าม retry เมื่อ:

- เป็น POST/PATCH/PUT/DELETE แม้ชื่อ endpoint จะเกี่ยวกับการอ่าน เช่น `POST /trades/simulate-sale` ก็ไม่ retry อัตโนมัติ
- มี HTTP status จริง เช่น 400/401/403/404/409/422/429/500/503 รวมถึง error จาก provider ที่ Backend ส่งกลับ
- เป็น `TimeoutError` ของ endpoint, AbortError, component ถูก destroy, ผู้ใช้สลับช่วงกราฟ/ออกจากหน้า, หรือ unsubscribe แล้ว
- response เป็น HTTP 200 แต่มี `PARTIAL`/`INCOMPLETE`/`retryAt`: ให้นโยบายข้อมูลและ cache ของ feature เดิมจัดการ
- request ไป Supabase/OAuth/รูปภาพ/CDN หรือบริการอื่น ไม่ใช่ Backend ที่กำหนด

## ลำดับ retry GET

```text
เริ่ม logical GET เดียว (มี deadline และ cancellation เดียว)
  → รอ ensureReady แบบมีขอบเขต
  → ส่ง GET attempt 1
      สำเร็จ → คืนผล
      HTTP error / timeout / ยกเลิก → คืน error ทันที ไม่ retry
      network status 0 → invalidate READY
        → ถ้า retry หมด/offline/ถูกยกเลิก/deadline หมด ให้จบ
        → รอ 500 ms โดยยกเลิกได้
        → รอ ensureReady รอบใหม่ (single-flight)
        → ส่ง GET attempt 2 พร้อม session ปัจจุบัน
          network status 0 → ทำซ้ำได้อีกครั้ง โดยรอ 1,500 ms
          attempt 3 ยังล้มเหลว → จบและแสดงปุ่มลองใหม่
```

ถ้า health รอบใดล้มเหลวให้หยุด logical GET นั้น ไม่ซ้อน retry ให้ health อีกหลายรอบจาก outer `retry()` ตั้งตัวนับระดับ logical request ไม่ reset ตัวนับเมื่อเข้า interceptor ใหม่หรือได้ health ผ่าน

วางลำดับเป็น readiness/network-retry → auth → HTTP เพื่อให้แต่ละ attempt ตรวจ session ปัจจุบันและไม่แนบ token ให้ health ใช้ `defer` หรือ request factory ให้การ resubscribe สร้าง downstream chain ใหม่อย่างถูกต้อง ห้ามครอบ service/cache/component ด้วย retry เพิ่มอีกชั้น มิฉะนั้น 3 attempts อาจทวีคูณ

## Session, cache และ UI

- status 0 หรือ health ไม่พร้อมไม่ใช่ session หมดอายุ: ไม่ logout, ไม่ล้าง Supabase session และไม่พาไปหน้า login
- คงนโยบาย 401 เดิม: `/auth/me` ได้ 401 `UNAUTHORIZED` จึงใช้ auth flow เดิม ส่วน login-username ได้ `INVALID_CREDENTIALS` ให้หน้า login แสดงตามเดิม ไม่ retry
- การกด login ให้รอ health ก่อนส่ง POST ถ้าส่งแล้วเกิด network error ให้แจ้งผู้ใช้ตรวจสถานะ/ลองเอง ไม่ resend username/password อัตโนมัติ
- ระหว่างรอแสดง “กำลังเชื่อมต่อระบบ…” ปิดปุ่มส่งซ้ำ และปิด loading ใน finally ทั้ง success/error/cancel เมื่อหมดรอบแสดง “เชื่อมต่อระบบไม่ได้ กรุณาลองใหม่” พร้อมปุ่มลองใหม่
- ไม่ลด timeout ของกราฟ/Win rate เหลือ health timeout; เมื่อ health พร้อมแล้วอาจยังต้องโหลดข้อมูล provider นานตาม feature เดิม
- เก็บ READY และ in-flight ไว้ใน RAM เท่านั้น ไม่ใช้ localStorage/sessionStorage และไม่ใช้ READY แทน cache ราคาหรือข้อมูลพอร์ต
- เมื่อ logout/user switch ให้ยกเลิกคำขอส่วนตัวที่รอ health/delay/API และล้างผล private cache ตามเดิม ไม่ให้ผลจาก session เก่ากลับมาอัปเดตหน้าจอ session ใหม่
- เมื่อ component ยกเลิก ให้ถอดเฉพาะ waiter ของ component นั้นออกจาก shared health ไม่ยกเลิก health ที่ยังมี waiter อื่นอยู่ ถ้าไม่มี waiter เหลือแล้วให้ abort request/timer และเคลียร์ flight
- การ retry ไม่สร้าง cache entry จาก error ไม่เลื่อน expiry ของข้อมูลเก่า และไม่ละเลย provider `retryAt` ที่ feature เดิมใช้อยู่
- หากใช้ Angular interceptor tests ให้ opt-out หรือ stub readiness ใน unit tests เดิมที่ไม่เกี่ยวข้อง เพื่อไม่ให้เกิด real HTTP จากชุดทดสอบ

## Acceptance tests สำหรับ Frontend

ใช้ fake timers/HttpTestingController หรือ mock network ไม่ต้องใช้บัญชีจริง:

1. เปิดหน้าแล้ว Backend ยังไม่พร้อม: health network error 2 ครั้ง ครั้งที่ 3 ผ่าน; ไม่มีคำขอธุรกิจส่งก่อน health ผ่าน
2. เปิดหลาย widget พร้อมกัน: ทั้งหมดแชร์ health flight เดียวและได้ผลพร้อมกัน ไม่มี polling ซ้ำราย component
3. Health ไม่พร้อมตลอด: ส่งไม่เกิน 4 ครั้งและจบใน 10 วินาที; ไม่เรียก API ธุรกิจ, loading หยุด, ไม่ logout และกดลองใหม่ได้
4. Health ตอบ 200 แต่ HTML/ผิด service: ไม่ถือว่า READY; ไม่เกิด recursion และ health ไม่แนบ token
5. GET ที่อยู่ในขอบเขตได้ status 0 สองครั้งแล้วสำเร็จ: รวมไม่เกิน 3 business attempts, หน่วง 500/1,500 ms และเช็ก health ใหม่ตาม TTL/invalidation
6. GET status 0 ตลอด: หยุดตามขอบเขต ไม่มี retry จาก component/cache มาคูณจำนวนครั้ง; health ล้มเหลวให้จบทันที
7. GET ตอบ 401/429/503 หรือ body INCOMPLETE พร้อม retryAt: ไม่มี network retry; auth/provider handling เดิมยังทำงาน
8. POST login/import/upload/simulator และ PATCH credentials ได้ network error: ส่งคำขอธุรกิจครั้งเดียว ไม่มี resend อัตโนมัติ
9. สลับช่วงกราฟ/ออกจากหน้า/logout/user switch ระหว่าง health, delay หรือ API: ไม่มี attempt ถัดไปและผลเก่าไม่อัปเดตหน้าจอ
10. Waiter หนึ่งยกเลิก: ไม่รบกวน waiter อื่น; ยกเลิกทุก waiter แล้วไม่มี timer/request ค้าง
11. Network ช้าจน Analytics ครบ deadline รวม 180 วินาที: ยกเลิกทั้งงานและไม่ retry timeout; deadline ไม่ถูกต่ออายุทุก attempt
12. offline, CORS/DNS/TLS, request ไป origin อื่น และ OAuth callback: ไม่วนไม่จำกัด ไม่ retry นอกขอบเขต ไม่วินิจฉัยว่าเป็น token หมดอายุ
13. READY อายุมากกว่า 5 วินาทีให้ probe ใหม่; ไม่มี polling ระหว่างพักหน้า และไม่เสิร์ฟ health จาก service worker/cache เก่า

เอกสารนี้ยังไม่ใช่ผลทดสอบว่า Frontend implement ครบ ต้องรัน acceptance tests ฝั่ง Frontend หลังลงโค้ดจริง
