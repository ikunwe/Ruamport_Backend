# Frontend: โลโก้กองทุนผ่าน SEC → AIMC → Logo.dev

เพิ่มรูปของบริษัทจัดการกองทุน (บลจ./AMC) ไม่ใช่รูปเฉพาะกองทุนแต่ละ class หุ้นนอกยังใช้ Finnhub หุ้นไทยยังใช้ SET และราคา/NAV/จำนวนหน่วย/ต้นทุนเดิมไม่เปลี่ยน ไม่มี SQL ใหม่หรือการ import ซ้ำ

## เรียกใช้และตั้งค่า

```http
GET /api/v1/trades/holdings?includeLogos=true
Authorization: Bearer <Supabase access token>
```

รวมกับ includeMarket=true และ includeFx=true ได้ตามเดิม ไม่ต้องมี endpoint ใหม่ Backend เลือกจาก holdings ของผู้ใช้ที่ login ไม่รับ URL หรือชื่อ บลจ. จาก client เมื่อไม่ส่ง includeLogos หรือส่ง false จะไม่เรียกบริการโลโก้

Backend ต้องมี SEC_API_KEY และ LOGO_DEV_PUBLISHABLE_KEY ใน .env แล้ว restart:

```env
SEC_API_KEY=
LOGO_DEV_PUBLISHABLE_KEY=
```

SEC ใช้ Primary หรือ Secondary key ตัวเดียว ส่วน Logo.dev ใช้ CDN publishable key ที่ขึ้นต้น pk_ ซึ่งตั้งใจให้ปรากฏใน URL รูปได้ **ห้ามใส่ Secret Key แทน** LOGO_DEV_SECRET_KEY ที่มีไว้สำหรับทดลอง Search API ไม่ได้ถูกใช้หรือส่งออกโดย flow นี้ Frontend ไม่ต้องถือ SEC key หรือ Logo.dev secret

## วิธีจับคู่แบบอัตโนมัติ

1. อ่าน fund profile/class ที่ตรงจาก SEC เพื่อหา unique_id ของ บลจ. และชื่อภาษาอังกฤษ ไม่ค้น domain จาก ticker กองทุน
2. ตรวจ ID เดิมกับรายชื่อผู้ประกอบธุรกิจปัจจุบันของ SEC ไม่ย้าย ID เก่าไปเป็นบริษัทใหม่เอง
3. จับคู่ชื่อกับสมาชิก AIMC แล้วอ่านเฉพาะ Website ของสมาชิกนั้น เก็บ subdomain จริง เช่น am.kkpfg.com
4. ถ้าชื่อไม่ตรง อ่านหน้า SEC ของ ID นั้นเพื่อเทียบเบอร์โทรทางการและความใกล้เคียงของชื่อกับ AIMC ต้องเหลือผลเดียวเท่านั้น ไม่ใช้เบอร์โทรอย่างเดียว
5. สร้าง URL รูป Logo.dev จาก domain ที่ยืนยันความสัมพันธ์ได้ หากไม่ชัดเจนให้ url=null แทนการเดา ไม่ใช้ตาราง hardcode domain ทีละ บลจ.

หน้า SEC/AIMC เป็น HTML สาธารณะ ไม่ใช่ API domain ที่รับประกัน schema หากเว็บเปลี่ยนหรือดึงไม่ได้ ระบบจะ fallback ไม่เลือกบริษัทอื่นแทน รายชื่อย้อนหลังใน SEC ไม่ได้แปลว่าบริษัทนั้นยังดำเนินงาน ไม่มีการ alias จากการควบรวมโดยอัตโนมัติ

## ตัวอย่าง response

ตัวอย่างเฉพาะฟิลด์ใน items[] ค่าเวลาและ publishable key เป็นตัวอย่าง:

```json
{
  "symbol": "KKP US500-UH-E",
  "assetType": "MUTUAL_FUND",
  "logoUrl": "https://img.logo.dev/am.kkpfg.com?token=pk_EXAMPLE&format=png&size=128&fallback=404",
  "logo": {
    "status": "UNVERIFIED",
    "source": "LOGO_DEV",
    "symbol": "KKP US500-UH-E",
    "providerSymbol": "KKP US500-UH-E",
    "projectId": "M0301_2567",
    "fundClassName": "KKP US500-UH-E",
    "amcId": "C0000005025",
    "amcName": "KIATNAKIN PHATRA ASSET MANAGEMENT COMPANY LIMITED",
    "domain": "am.kkpfg.com",
    "directorySource": "AIMC",
    "directoryUrl": "https://association.aimc.or.th/members/",
    "matchedDirectoryName": "Kiatnakin Phatra Asset Management Company Limited",
    "matchMethod": "EXACT_NAME",
    "directoryFetchedAt": "2026-10-22T08:00:00.000Z",
    "secRegistryCheckedAt": "2026-10-22T08:00:00.000Z",
    "url": "https://img.logo.dev/am.kkpfg.com?token=pk_EXAMPLE&format=png&size=128&fallback=404",
    "domainVerified": true,
    "verified": false,
    "logoRepresents": "AMC",
    "fallbackText": "KKP US500-UH-E",
    "fetchedAt": "2026-10-22T08:00:00.000Z",
    "expiresAt": "2026-10-22T09:00:00.000Z",
    "fromCache": false,
    "isStale": false
  }
}
```

UNVERIFIED/verified=false หมายถึง Backend ยังไม่ได้ตรวจไฟล์รูปที่ CDN ในคำขอนี้ domainVerified=true หมายถึงจับคู่ domain กับแหล่งข้อมูลได้ ไม่ใช่การรับประกันว่ารูปมีอยู่ ถูกต้อง หรือเป็นแบรนด์ล่าสุด matchMethod อีกค่าคือ OFFICIAL_PHONE_AND_NAME

ถ้าหาไม่ได้ logoUrl=null และ logo มี status=UNAVAILABLE, source=LOGO_DEV, url=null, logoRepresents=AMC, fallbackText, errorCode, retryAt พร้อม symbol ไม่ทำให้ holdings ล้มเหลวทั้งหน้า รหัสที่อาจพบ:

| errorCode | ความหมาย |
|---|---|
| LOGO_DEV_KEY_MISSING | ไม่มี publishable key ที่ถูกต้อง |
| LOGO_AMC_IDENTITY_UNAVAILABLE | ไม่มีข้อมูล บลจ. ที่ยืนยันได้จาก fund profile |
| LOGO_AMC_NOT_CURRENTLY_LISTED | ID ไม่อยู่ในรายชื่อปัจจุบันที่ตรวจได้ ไม่สรุปสถานะทางกฎหมาย |
| LOGO_AMC_AMBIGUOUS | ข้อมูลจับคู่กำกวม |
| LOGO_AMC_DOMAIN_UNRESOLVED | ยังระบุ domain ไม่ได้ |
| LOGO_DIRECTORY_UNAVAILABLE | แหล่งข้อมูลอ่านไม่ได้หรือรูปแบบเปลี่ยน |
| LOGO_DIRECTORY_RATE_LIMITED | ต้องรอก่อนเรียกแหล่งข้อมูลใหม่ |
| LOGO_NOT_AVAILABLE | ข้อผิดพลาดโลโก้อื่นที่ไม่เปิดเผยรายละเอียด upstream |

อาจมีรหัส LOGO_* จากการค้น fund profile เพิ่มเติม ใช้ fallback เดียวกัน ไม่ต้องแสดง errorCode ให้ผู้ใช้ทั่วไป กองทุนที่ขายหมด/สกุลไม่รองรับจะไม่มีรูป (logo=null, logoUrl=null) รองรับเฉพาะ MUTUAL_FUND, THB และ quantity ที่เป็นจำนวน finite > 0

## Frontend ต้องทำ

- ใช้ item.logoUrl เป็น src แม้ status เป็น UNVERIFIED อย่ากรองเฉพาะ AVAILABLE
- แสดงชื่อย่อ item.symbol หรือ logo.fallbackText ตั้งแต่เริ่ม ระหว่างโหลด และเมื่อไม่มี URL
- เมื่อ img load สำเร็จจึงแสดงรูป หาก error เช่น 404/403/เครือข่าย/CSP ให้แสดงชื่อย่อ ห้ามวน retry URL เดิมหรือแจ้งผิดพลาดทั้งหน้า
- Reset loaded/failed เมื่อ URL หรือรายการเปลี่ยน ใช้ alt/title ว่าโลโก้ บลจ. ตาม logo.amcName เพื่อไม่ให้เข้าใจว่าเป็นโลโก้กองทุนเฉพาะ class
- ถ้ามี CSP เพิ่ม https://img.logo.dev ใน img-src โดยเก็บโดเมนหุ้นนอก/SET เดิมไว้ ใช้ img ปกติ ไม่ต้อง fetch bytes หรือทำ image proxy
- ความล้มเหลวของรูปไม่กระทบการแสดง NAV, valuation หรือต้นทุน

ตัวอย่างแนวทาง JavaScript ยังไม่ได้แก้ source Frontend:

```js
function renderFundLogo(container, item) {
  container.replaceChildren();
  const fallback = document.createElement('span');
  fallback.textContent = item.logo?.fallbackText || item.symbol;
  container.append(fallback);
  if (!item.logoUrl) return;
  const img = document.createElement('img');
  img.alt = `โลโก้ บลจ. ${item.logo?.amcName || item.symbol}`;
  img.width = 40;
  img.height = 40;
  img.style.objectFit = 'contain';
  img.hidden = true;
  img.referrerPolicy = 'no-referrer';
  img.onload = () => { img.hidden = false; fallback.hidden = true; };
  img.onerror = () => { img.remove(); fallback.hidden = false; };
  container.append(img);
  img.src = item.logoUrl;
}
```

## Cache และข้อจำกัด

ใช้ cache ใน process ร่วมกันทุกผู้ใช้สำหรับข้อมูลสาธารณะเท่านั้น ไม่แชร์จำนวนหน่วย/ต้นทุน ไม่เก็บรูปใน DB หรือ proxy รูป: SEC fund identity ใช้ cache เดิม 7 วัน, หน้า directory 6 ชั่วโมง, domain และ logo metadata 1 ชั่วโมง พร้อม single-flight และจำกัดขนาด cache ผลผิดพลาดปกติรอ 5 นาที กรณี ID ไม่อยู่ในรายชื่อปัจจุบันรอ 1 ชั่วโมง หาก directory ส่ง Retry-After อาจรอนานกว่านั้น ไม่ใช้ metadata หมดอายุเมื่อการตรวจใหม่ล้มเหลว

มี budget ภายใน 20 ครั้ง/นาทีต่อ official host สำหรับหน้า directory ไม่ใช่การรับประกัน quota ของ SEC/AIMC การเรียกและ cache metadata ไม่ได้ลดจำนวนครั้งที่ browser โหลด CDN โดยอัตโนมัติ รูปขึ้นกับ cache และ quota ของ Logo.dev/browser การ deploy หลาย instance แยก cache/budget กัน

ทดสอบ flow จริงกับ KKP US500-UH-E → am.kkpfg.com, K-US500X-A(A) → kasikornasset.com, SCBS&P500 → scbam.com ได้แล้ว การทดสอบนี้ตรวจการจับคู่และสร้าง URL ไม่ใช่การยืนยันภาพในทุก browser สมาชิกบางรายอาจยังใช้ชื่อ/domain เก่าใน AIMC เช่น Aberdeen จึงอาจได้รูปแบรนด์เก่าหรือโหลดไม่ได้ ให้ใช้ fallback ไม่รับประกันครอบคลุมทุก บลจ. ในอนาคต

ทดสอบแบบอ่านอย่างเดียว ไม่มีการเขียน DB:

```sh
node --use-system-ca --env-file=.env scripts/verification/verify-fund-logos.cjs
```

แหล่งข้อมูล: [SEC ผู้ประกอบธุรกิจ](https://market.sec.or.th/LicenseCheck/views/Intermediaries?lang=en), [สมาชิก AIMC](https://association.aimc.or.th/members/), [Logo.dev attribution](https://www.logo.dev/docs/platform/attribution) ตามเงื่อนไขปัจจุบันโครงการส่วนตัวที่บุคคลเป็นเจ้าของและไม่มีรายได้ไม่ต้อง attribution; Community สำหรับงานเชิงพาณิชย์ต้องมี attribution ตามข้อกำหนด ตรวจเงื่อนไขบริการและสิทธิ์เครื่องหมายอีกครั้งก่อนขยายการใช้งาน URL ที่เปิดได้ไม่ใช่ใบอนุญาตใช้แบรนด์
