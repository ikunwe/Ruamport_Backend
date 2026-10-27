# โลโก้หุ้นที่ขายหมดแล้วสำหรับประวัติซื้อขาย

## เรียก endpoint เดิม

```http
GET /api/v1/trades/holdings?includeClosed=true&includeLogos=true
Authorization: Bearer <access_token>
```

ไม่ต้องเพิ่ม endpoint, SQL หรือ `.env` ใช้ Finnhub key/การตั้งโลโก้เดิม และไม่ต้อง import PDF ซ้ำ

- `includeClosed=true` ให้ holdings คืนทั้งที่ยังถือและขายหมดของ authenticated user
- `includeLogos=true` เพิ่ม logoUrl/logo ให้หุ้นนอก USD และหุ้นไทย THB ที่ quantity=0 ได้ด้วย
- อย่าใส่ `includeMarket=true` หรือ `includeFx=true` หากต้องการเพียงข้อมูลสำหรับตกแต่งประวัติ ทั้งสอง flag default=false ไม่มีการเรียกราคา/ข่าว/FX เพิ่มเพราะเปิดโลโก้
- นี่ยังเป็น holdings response เดิมพร้อมฟิลด์โลโก้ ไม่ใช่ payload ที่มีแต่รูปภาพ; จำนวนถือ/ต้นทุน/ฟิลด์เดิมไม่ได้ถูกลบหรือคำนวณจากราคาตลาดใหม่
- `/trades/transactions` ยังคืนประวัติแบบเดิม ไม่ได้แนบโลโก้ให้ทุกแถวอัตโนมัติ ใช้ holdings response นี้เป็น lookup map สำหรับประวัติได้ ไม่ต้องขอรูปทีละรายการซื้อขาย
- Backend เลือกจาก holdings ที่บันทึกไว้ของ user เท่านั้น ไม่รับ symbol, URL หรือ userId ที่ query ส่งมาเป็นรายการให้ดึงรูป ไม่เปิดให้ค้นหาโลโก้หุ้นที่ไม่เคยมีในระบบ

## Response ที่เพิ่มให้ closed stocks

ตัวอย่างเฉพาะฟิลด์สำคัญ (ข้อมูลอื่นของ holdings ยังอยู่ตามเดิม):

```json
{
  "items": [
    {
      "assetType": "OFFSHORE_STOCK",
      "symbol": "AMD",
      "exchange": "XNAS",
      "currency": "USD",
      "status": "CLOSED",
      "quantity": 0,
      "logoUrl": "https://static2.finnhub.io/file/publicdatany/finnhubimage/stock_logo/AMD.png",
      "logo": {
        "status": "AVAILABLE",
        "source": "FINNHUB",
        "symbol": "AMD",
        "micCode": "XNAS",
        "url": "https://static2.finnhub.io/file/publicdatany/finnhubimage/stock_logo/AMD.png"
      }
    },
    {
      "assetType": "THAI_STOCK",
      "symbol": "ASK",
      "exchange": null,
      "currency": "THB",
      "status": "CLOSED",
      "quantity": 0,
      "logoUrl": "https://media.set.or.th/common/logo/company/ASK.png",
      "logo": {
        "status": "UNVERIFIED",
        "source": "SET",
        "symbol": "ASK",
        "url": "https://media.set.or.th/common/logo/company/ASK.png",
        "verified": false,
        "fallbackText": "ASK"
      }
    }
  ]
}
```

Finnhub metadata fetchedAt/expiresAt/fromCache/isStale/retryAt/errorCode ยังใช้รูปแบบเดิม ตัวอย่างย่อไม่ได้แสดงทุก field

### ขอบเขตที่ไม่เปลี่ยน

- ไม่ส่งสอง flags: พฤติกรรมเดิม ไม่เพิ่มงานโหลดโลโก้
- ส่ง includeLogos อย่างเดียว: ใช้เฉพาะหุ้นที่ยังถือเช่นเดิม ไม่เปิด closed rows ที่ไม่ได้ขอ
- ส่ง includeClosed อย่างเดียว: คืน closed holdings แต่ไม่เรียกโลโก้
- ต้องมี quantity เป็น finite number >=0 สำหรับโลโก้ที่ opt-in รวม closed; ค่าติดลบ/NaN/รูปแบบหรือ identity ไม่รองรับ ไม่ถูกใช้ขอรูป
- ราคาหุ้นและข่าวยังจำกัดหุ้นที่ถือ quantity>0 ตามเดิม แม้ขอ includeMarket ร่วมด้วยก็ไม่เพิ่มคำขอราคาหุ้นที่ quantity=0
- กองทุนไม่ได้เพิ่มการรองรับ closed logo ในงานนี้ กองทุนที่ยังถือคงใช้ SEC/AIMC/Logo.dev เดิม; includeLogos ยังอาจขอข้อมูลระบุ บลจ. เพื่อโลโก้ แต่ไม่ใช่การขอราคา NAV
- รูปเป็นโลโก้ปัจจุบันของบริษัท ไม่รับประกันโลโก้แบรนด์ในวันซื้อขายเดิม หุ้นย้ายตลาดรองรับ logo-only current-listing fallback ตามส่วนด้านล่าง หาก ticker หาย/เพิกถอนหรือยืนยัน identity ไม่ได้ ยังคืน unavailable ไม่เดาบริษัทจากชื่อใกล้เคียง

## จับคู่กับแถวประวัติใน frontend

1. โหลด transactions ตาม pagination เดิม และโหลด holdings พร้อมสอง flags หนึ่งครั้งเมื่อเข้าประวัติ หากมี holdings ชุดที่รวม closed และโลโก้อยู่แล้ว ใช้ชุดนั้นได้เลย
2. สร้าง image lookup จากหุ้นใน holdings โดยใช้ identity เช่น `assetType + symbol.toUpperCase() + exchange + currency` ไม่ยึด index หรือชื่อบริษัท และไม่ใช้ symbol อย่างเดียวข้ามทุกตลาด
3. จับคู่กับ identity ของ history view model ที่ frontend ใช้อยู่ `transactions` ดิบมี asset_name เป็นชื่อหลักทรัพย์และ details.exchange; ประเภทสินทรัพย์ให้ใช้ข้อมูลประเภทเอกสาร/การ normalize ที่มีอยู่ ไม่สมมุติว่าทุกรายการเป็นหุ้นนอก และไม่เปลี่ยน schema transaction เดิมเพื่อแสดงรูป
4. หุ้นเดียวกันหลายบัญชีใช้รูปเดียวกันได้ แต่ไม่รวมจำนวนถือหรือต้นทุนของบัญชีเข้าด้วยกันเพราะจับคู่โลโก้ รูปไม่เกี่ยวกับจำนวน units ของแต่ละคำสั่ง
5. หาก identity ประวัติไม่ครบหรือจับคู่ได้หลายตลาด ห้ามเดาจับรูปของบริษัทอื่น ให้แสดง symbol เป็น fallback ถ้าตลาดหุ้นไทยถูก normalize เป็น SET/MAI/XBKK/null ให้ใช้กติกา normalization แบบเดียวกันทั้งสองฝั่ง

ใช้ logoUrl ที่ Backend ส่ง ไม่ต้องสร้าง Finnhub URL หรือส่ง key ไป browser เพิ่ม สำหรับ SET ให้ใช้ได้แม้ status=UNVERIFIED แต่ต้องมี onerror แสดงชื่อย่อแทน ไม่แปลว่า UNVERIFIED เป็นข้อมูลเสีย และไม่แปลว่าโหลดรูปได้แน่นอน

## Cache และ fallback

- หุ้นนอกใช้ catalog/profile และ public logo cache ชุดเดียวกับหุ้นที่ยังถือ ไม่ทำ cache แยกสำหรับ closed หรือแยกทุก user หุ้นซ้ำหลายบัญชี/หลายคำสั่งไม่ขอ profile ซ้ำต่อรอบ cache
- ค่า default โลโก้ Finnhub 7 วัน มี bounded stale fallback 30 วัน/negative caching และ rate-limit behavior เดิม ข้อมูล list holdings ส่วนตัวไม่ถูกแชร์ข้ามผู้ใช้
- หุ้นไทยสร้าง SET URL ตาม symbol ที่ตรวจแล้ว ไม่ HEAD/GET/proxy ภาพหรือขอ Yahoo รูปใช้ cache browser/CDN ตาม response headers ของ SET ไม่อ้างว่า Backend ตรวจรูปแล้ว
- ไม่พบโลโก้/โดนจำกัด: logoUrl=null หรือ logo.status=UNAVAILABLE พร้อม errorCode/retryAt; ประวัติและยอดเดิมยังแสดงได้ ไม่ต้องซ่อนหุ้นหรือแสดงสถานะว่า import ผิด
- ใช้รูปสำรองหรือชื่อย่อเมื่อ URL ไม่มี/กำลังโหลด/โหลดไม่ได้ ใส่ alt, lazy loading และ referrerPolicy ตามนโยบายหน้าเว็บ ไม่ retry รูปหรือ endpoint รัว ๆ ก่อน retryAt
- holdings response เป็นข้อมูลส่วนตัว ผ่าน Bearer auth และ Cache-Control: no-store ถ้า frontend เก็บ lookup ใน memory ให้ล้างเมื่อ logout/เปลี่ยน user และโหลดรายชื่อใหม่หลัง import/ลบรายการ ไม่ใช้รายการพอร์ตของ user ก่อนหน้า แม้รูป URL จะเป็นข้อมูลสาธารณะ
- การเปิดดูประวัติไม่ควรยิง quote/news endpoints เป็นผลข้างเคียงเพียงเพื่อให้ได้รูป

## การตรวจสอบ

ชุดทดสอบครอบคลุม closed stock logo opt-in, cache ร่วมกับ held stock/หลายบัญชี/หลาย user, รูปหุ้นไทย, error fallback, ไม่มี quote/news/FX/NAV calls เพิ่ม, flags เดิมและ authentication ทั้งหมด ไม่มีการอ่านหรือแก้ข้อมูลจริงของ user ในการทดสอบ

ดูเงื่อนไขรูปและ fallback เพิ่มใน [คู่มือ SET logo](FRONTEND_THAI_STOCK_LOGO_GUIDE.md) สิทธิ์การใช้/แสดงรูปยังเป็นไปตามข้อจำกัดของ provider และเจ้าของเครื่องหมายเดิม ไม่ได้ขยายสิทธิ์เพราะแสดงในประวัติ

## หุ้นย้ายตลาด เช่น QS: ยืนยันตลาดปัจจุบันเฉพาะโลโก้

ใช้ endpoint/flags เดิมทั้งหุ้นที่ยังถือและขายหมด ไม่ต้องส่งตลาดใหม่หรือแก้ข้อมูลเก่า หากไม่มี listing ตรงกับตลาดใน PDF เส้นทางโลโก้สามารถใช้ listing ปัจจุบันที่ตรวจสอบได้ดังนี้:

1. ใช้ Finnhub US catalog แบบ exact symbol และ USD ต้องมีตลาดปัจจุบันที่รองรับเพียงหนึ่งกลุ่ม (Nasdaq MIC family ถือเป็นกลุ่มเดียว) และ security type ต้องรู้จัก/ไม่ขัดกัน
2. ขอ profile2 ของ ticker เดิม โดย profile ต้องยืนยัน ticker ตรงตัว, currency=USD และตลาดสอดคล้องกับ current catalog ไม่ใช้ ADR issuer alias ข้ามประเทศเพื่อ bypass เงื่อนไข fallback นี้
3. ตรวจ URL รูปด้วย HTTPS/hostname/path policy เดิม ไม่รับ URL จาก client หรือค้นหาบริษัทจากชื่อคล้ายกัน ถ้ายืนยันไม่ได้ให้ logoUrl=null พร้อม LOGO_IDENTITY_UNVERIFIED หรือ LOGO_IDENTITY_AMBIGUOUS; รูปหายหรือ provider error ยังมี error เดิมได้

ตัวอย่าง QS จากข้อมูลเก่า exchange=XNYS แต่ catalog/profile ปัจจุบันตรงกันที่ Nasdaq:

```json
{
  "symbol": "QS",
  "exchange": "XNYS",
  "quantity": 0,
  "logoUrl": "https://static2.finnhub.io/file/publicdatany/finnhubimage/stock_logo/QS.png",
  "logo": {
    "status": "AVAILABLE",
    "source": "FINNHUB",
    "symbol": "QS",
    "micCode": "XNYS",
    "providerSymbol": "QS",
    "providerMicCode": "XNAS",
    "url": "https://static2.finnhub.io/file/publicdatany/finnhubimage/stock_logo/QS.png",
    "listingResolution": {
      "type": "CURRENT_LISTING_FOR_LOGO",
      "source": "FINNHUB_CATALOG_AND_PROFILE",
      "fromMic": "XNYS",
      "toMic": "XNAS",
      "verifiedAt": "2026-10-25T14:58:09.075Z",
      "effectiveDate": null,
      "pdfMarketPreserved": true
    }
  }
}
```

- `item.exchange` และ `logo.micCode` ยังเป็นตลาดต้นฉบับ ใช้จับคู่ history ตามเดิม ห้ามเอา providerMicCode ไปเขียนทับ PDF/transactions หรือเปลี่ยน key ของแถวประวัติ
- `providerMicCode` คือ listing ที่ใช้ยืนยันโลโก้; `listingResolution` ระบุเหตุผลที่ใช้ตลาดปัจจุบัน หากตรงตลาดเดิมอยู่แล้ว field นี้เป็น null รูปแบบเดิมยังใช้แสดงรูปได้ โดยไม่ต้องมี UI เพิ่มสำหรับ metadata นี้
- ไม่ได้พิสูจน์ว่าตลาดใน PDF ผิดหรือยืนยันวันย้ายตลาด จึงคง effectiveDate=null และไม่อ้างว่า verifiedAt เป็นวันย้าย กรณี ticker reuse/rename ที่เปลี่ยนบริษัทไม่ถือว่าถูก reconcile โดย metadata นี้
- Cache โลโก้และการจับคู่ยังผูกกับ identity ต้นฉบับ ใช้ร่วมกันข้าม user ที่มี identity เดียวกัน ไม่มีข้อมูลพอร์ตถูกแชร์ ไม่เปลี่ยน price cache หรือ catalog สำหรับการตรวจราคา
- **fallback นี้ไม่ใช้กับราคาและข่าว** ราคาที่ระบุตลาดเก่ายังผ่าน strict listing check เดิม จึงอาจเป็น PRICE_NOT_AVAILABLE แม้โลโก้พร้อมแล้ว ห้าม frontend เปลี่ยนราคาเป็นของตลาดใหม่เพียงเพราะรูปโหลดได้
- ไม่มีการแก้ PDF/จำนวนหุ้น/ต้นทุน/SQL/กราฟย้อนหลัง และไม่เพิ่มคำขอ quote หรือ news เพราะขอโลโก้

ตรวจ QS จริงได้ด้วย `node --use-system-ca --env-file=.env scripts/verification/verify-moved-stock-logo.cjs` ใช้ position จำลอง XNYS, ตรวจ catalog/profile, cache hit, ยืนยันว่าการตรวจราคาเก่าไม่ส่ง /quote และตรวจ HTTP/content-type ของรูปผ่าน Finnhub CDN โดยไม่อ่าน DB หรือบันทึกรูป

ในการทดสอบจริง URL static2.finnhub.io ส่ง 302 ไป static9.finnhub.io แล้วได้ HTTP 200 image/png Backend ยังส่ง URL ต้นทางของ profile ไม่ proxy ภาพ หากเว็บมี CSP ต้องอนุญาต img-src ของ URL ต้นทางและ CDN ปลายทางที่ตรวจสอบแล้วด้วย (เช่น https://static2.finnhub.io และ https://static9.finnhub.io) พร้อม fallback ชื่อย่อเมื่อ browser โหลดไม่ได้ อย่าเปิด wildcard ทุกโดเมนเพียงเพื่อหลบ CSP
