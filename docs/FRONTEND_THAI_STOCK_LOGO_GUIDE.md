# Frontend: โลโก้หุ้นไทยจาก URL ของ SET (ใช้งานส่วนตัว)

## Endpoint

~~~http
GET /api/v1/trades/holdings?includeLogos=true
Authorization: Bearer <Supabase access_token>
~~~

includeLogos เป็น opt-in แยกจาก includeMarket/includeFx ใช้ร่วมกันได้ ไม่เพิ่ม endpoint ใหม่
Backend เลือกจาก holdings ของ authenticated user เท่านั้น ไม่รับ symbol/URL จาก query เพื่อสร้างรูป

## Response ของหุ้นไทย

ตัวอย่างเฉพาะฟิลด์โลโก้ใน items[]:

~~~json
{
  "symbol": "ASK",
  "logoUrl": "https://media.set.or.th/common/logo/company/ASK.png",
  "logo": {
    "status": "UNVERIFIED",
    "source": "SET",
    "symbol": "ASK",
    "providerSymbol": "ASK",
    "url": "https://media.set.or.th/common/logo/company/ASK.png",
    "verified": false,
    "fallbackText": "ASK"
  }
}
~~~

Backend สร้าง URL จาก symbol ที่ผ่าน validation และ uppercase เท่านั้น:
https://media.set.or.th/common/logo/company/{SYMBOL}.png

UNVERIFIED หมายถึงมี URL ให้ลองโหลด ไม่ใช่รูปเสีย และไม่ใช่การยืนยันว่าหุ้นนั้นมีรูปอยู่จริง Backend ไม่ HEAD/GET รูป ไม่ scrape SET ไม่ขอ cookie/crumb Yahoo และไม่เก็บไฟล์รูป/cache ลงระบบ จึงไม่มี fetchedAt/expiresAt/retryAt สำหรับโลโก้ SET การ cache ไฟล์เป็นไปตาม browser และ response headers ของ SET ไม่ใช้ cache ราคาหรือ cache โลโก้ Finnhub

ASK และ PTT เคยตรวจ URL จริงแล้วได้ HTTP 200 image/png แต่ไม่รับประกันทุก symbol หรือการเข้าถึงจากทุก browser ในอนาคต ไม่คืน AVAILABLE ให้ URL ที่ไม่ได้ตรวจในคำขอนั้น

ใช้กับ THAI_STOCK, currency=THB, จำนวนหุ้น finite > 0, exchange ว่างหรือ SET/MAI/XBKK และ symbol ที่รองรับ หากส่ง includeClosed=true ร่วมกับ includeLogos=true จะรองรับหุ้นขายหมด quantity=0 ด้วย โดยไม่ขอราคาหุ้นเพิ่ม ดู [โลโก้หุ้นขายหมดสำหรับประวัติ](FRONTEND_CLOSED_STOCK_LOGOS_GUIDE.md) ข้อมูลที่ไม่รองรับยังมี logoUrl=null, logo=null กองทุน THB ที่ยังถือใช้ SEC/AIMC/Logo.dev แยกจาก SET ดู [คู่มือโลโก้กองทุน](FRONTEND_MUTUAL_FUND_LOGO_GUIDE.md) ไม่ส่ง includeLogos/ส่ง false: ไม่มีฟิลด์โลโก้เพิ่มตามเดิม

หุ้นนอกยังใช้ Finnhub: status AVAILABLE/UNAVAILABLE และ metadata/cache เดิม ไม่เปลี่ยนเป็น UNVERIFIED

## Frontend ต้องเพิ่ม fallback

1. ใช้ items[].logoUrl เป็น src โดยไม่กรองเฉพาะ logo.status=AVAILABLE เพราะ SET ใช้ UNVERIFIED
2. ก่อนรูปโหลดสำเร็จ แสดงชื่อย่อ items[].symbol ไว้ก่อน
3. เมื่อ img load สำเร็จจึงแสดงรูป เมื่อ error (404/403/เครือข่าย/CSP) แสดงชื่อย่อแทน ห้ามวนตั้ง src เดิมเพื่อ retry
4. ถ้า logoUrl=null แสดงชื่อย่อทันที ใช้ logo.fallbackText ได้สำหรับ SET หรือใช้ symbol ซึ่งมีในทุก item
5. Reset สถานะ loaded/failed เมื่อเปลี่ยน symbol หรือ URL ไม่ส่งข้อความผิดพลาดทั้งหน้าเพียงเพราะรูปไม่มี

ตัวอย่าง JavaScript ฝั่ง Frontend (เพื่อเป็นแนวทาง ยังไม่ได้แก้ source Frontend):

~~~js
function renderHoldingLogo(container, item) {
  container.replaceChildren();
  const fallback = document.createElement('span');
  fallback.textContent = item.symbol;
  container.append(fallback);
  if (!item.logoUrl) return;

  const img = document.createElement('img');
  img.alt = item.symbol;
  img.width = 40;
  img.height = 40;
  img.hidden = true;
  img.style.objectFit = 'contain';
  img.onload = () => { img.hidden = false; fallback.hidden = true; };
  img.onerror = () => { img.remove(); fallback.hidden = false; };
  container.append(img);
  img.src = item.logoUrl;
}
~~~

หากมี Content Security Policy ให้ img-src อนุญาต https://media.set.or.th เพิ่มจาก Finnhub ตามเดิม ไม่ต้อง fetch รูปผ่าน JavaScript/canvas หรือทำ image proxy ที่ Backend เพื่อแสดง img ปกติ

## ขอบเขต

- เพิ่มเฉพาะโลโก้และ metadata ไม่แก้ราคา Yahoo, NAV กองทุน, ต้นทุน, จำนวนหุ้น, SQL หรือ .env
- Frontend เป็นผู้สลับชื่อย่อเมื่อโหลดรูปไม่สำเร็จ Backend ไม่รู้ผล image load ของ browser
- ใช้เพื่อโครงการส่วนตัวตามขอบเขตที่ตกลง ไม่ถือว่าได้สิทธิ์เผยแพร่สาธารณะ/เชิงพาณิชย์จาก URL ที่เปิดได้ ก่อนขยายการใช้งานให้ตรวจสอบกับ SET และเจ้าของเครื่องหมาย ตาม [เงื่อนไข SET](https://www.set.or.th/th/terms-and-conditions)

