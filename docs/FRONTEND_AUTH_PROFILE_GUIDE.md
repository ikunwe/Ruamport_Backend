# Frontend Auth & Profile Integration Guide

อัปเดตระบบลงทุน: หลัง SQL 007 การอ่าน Preview จะบันทึกข้อมูลที่ parse และประวัติอ่านลง DB แล้ว แต่ยังไม่สร้างรายการลงทุนจนกด POST /trades/import รองรับ record.id/status, ALREADY_READ และ ALREADY_IMPORTED ดู [คู่มือบันทึกรายการลงทุน](FRONTEND_INVESTMENT_IMPORT_GUIDE.md) สำหรับ endpoint และ flow ใหม่

เอกสารนี้เป็นแนวทางสำหรับแก้ Angular Frontend ให้ทำงานตรงกับ Backend และ Supabase Auth เมื่อผู้ใช้ Login ด้วยหลาย Social Providers แต่ใช้อีเมลเดียวกัน

## 1. หลักการสำคัญ

Supabase อาจเชื่อม Google, Facebook และ Apple Identity ที่มี verified email เดียวกันเข้ากับ `auth.users` คนเดียวกัน ซึ่งเป็นพฤติกรรมที่ตั้งใจไว้

```text
Google: user@gmail.com ───┐
                          ├── Supabase auth.users ID เดียว
Facebook: user@gmail.com ─┘
```

Frontend ต้องถือว่า:

- Supabase session ใช้สำหรับ Authentication และ token lifecycle
- `public.profiles` ใช้เป็น Profile หลักของแอป
- `user.id` จาก Supabase คือรหัสผู้ใช้หลัก
- Provider ที่ Login ล่าสุดไม่ใช่เจ้าของข้อมูล Profile หลัก

## 2. Source of Truth

ใช้ข้อมูลตามตารางนี้:

| ข้อมูล | แหล่งข้อมูลที่ต้องใช้ |
|---|---|
| Access token / Refresh token | Supabase session |
| User ID | `session.user.id` หรือ `GET /auth/me` |
| Email | `GET /auth/me` |
| ชื่อที่แสดง | `GET /auth/me` → `profile.full_name` |
| รูป Profile | `GET /auth/me` → `profile.avatar_url` |
| Username | `GET /auth/me` → `profile.username` |
| สถานะ Username Login | `GET /auth/me` → `usernameLoginEnabled` |
| วิธีนำเข้า PDF | `GET /auth/me` → `ingestionRoute` |

ห้ามใช้ค่าต่อไปนี้เป็น Profile หลักของ UI:

```ts
session.user.user_metadata.full_name
session.user.user_metadata.name
session.user.user_metadata.avatar_url
session.user.app_metadata.provider
```

ค่าเหล่านี้เป็น metadata ของ Social Provider และอาจเปลี่ยนเมื่อผู้ใช้ Login ด้วย Provider อื่น

อนุญาตให้ใช้ `user_metadata` เป็น fallback ชั่วคราวเฉพาะตอนที่ Backend ยังไม่มีค่าใน `profiles` เท่านั้น และไม่ควรบันทึกทับ Profile อัตโนมัติจาก Frontend

## 3. API Base URL

Development:

```text
http://localhost:3000/api/v1
```

ควรกำหนดผ่าน Angular environment:

```ts
export const environment = {
  production: false,
  apiUrl: 'http://localhost:3000/api/v1',
};
```

## 4. Social Login Flow

Social Login ครั้งแรกและครั้งถัดไปใช้ flow เดียวกัน:

```text
กด Google / Facebook / Apple
        ↓
Supabase signInWithOAuth
        ↓
Redirect กลับ /auth/callback
        ↓
Supabase สร้างหรือคืน session
        ↓
Frontend เรียก GET /api/v1/auth/me
        ↓
เก็บ response เป็น App User State
        ↓
เข้า Dashboard
```

ตัวอย่าง:

```ts
async signInWithProvider(provider: 'google' | 'facebook' | 'apple') {
  const { error } = await this.supabase.auth.signInWithOAuth({
    provider,
    options: {
      redirectTo: `${window.location.origin}/auth/callback`,
    },
  });

  if (error) {
    throw error;
  }
}
```

ไม่ต้องแยก logic ว่า Provider ใดเป็นผู้ใช้ใหม่จากฝั่ง Frontend ให้ใช้ `GET /auth/me` เป็นตัวกำหนดสถานะของแอป

## 5. Auth Callback

ที่หน้า `/auth/callback`:

1. รอให้ Supabase คืน session
2. ตรวจว่ามี `access_token`
3. เรียก Backend `/auth/me`
4. บันทึก Profile ลง Auth Store
5. Redirect ไป Dashboard

ตัวอย่างแนวทาง:

```ts
const { data, error } = await this.supabase.auth.getSession();

if (error || !data.session) {
  // แสดงข้อความ Login ไม่สำเร็จ และกลับหน้า Login
  return;
}

const appUser = await firstValueFrom(this.authApi.getMe());
this.authStore.setUser(appUser);
this.router.navigateByUrl('/dashboard');
```

## 6. Bearer Token Interceptor

ทุก Backend endpoint ที่ต้อง Login ต้องแนบ Supabase access token:

```http
Authorization: Bearer SUPABASE_ACCESS_TOKEN
```

ตัวอย่าง Angular interceptor:

```ts
export const authInterceptor: HttpInterceptorFn = (request, next) => {
  const supabase = inject(SupabaseService);

  return from(supabase.client.auth.getSession()).pipe(
    switchMap(({ data }) => {
      const accessToken = data.session?.access_token;

      if (!accessToken) {
        return next(request);
      }

      return next(
        request.clone({
          setHeaders: {
            Authorization: `Bearer ${accessToken}`,
          },
        }),
      );
    }),
  );
};
```

ไม่ควรเก็บ token ซ้ำเองในตัวแปรที่ไม่ sync กับ Supabase ให้ Supabase client จัดการ session และ refresh token

## 7. GET `/auth/me`

Request:

```http
GET /api/v1/auth/me
Authorization: Bearer ACCESS_TOKEN
```

Response ปัจจุบัน:

```json
{
  "user": {
    "id": "user-uuid",
    "email": "user@gmail.com"
  },
  "profile": {
    "id": "user-uuid",
    "email": "user@gmail.com",
    "username": "portfolio.user",
    "full_name": "Portfolio User",
    "avatar_url": "https://cdn.example.com/avatar.png",
    "password_enabled": true,
    "created_at": "2026-01-01T00:00:00.000Z",
    "updated_at": "2026-01-01T00:00:00.000Z"
  },
  "usernameLoginEnabled": true,
  "ingestionRoute": {
    "emailDomain": "gmail.com",
    "channel": "GMAIL_API",
    "connectionProvider": "GOOGLE",
    "requiresMailConnection": true,
    "nextAction": "CONNECT_GOOGLE_MAIL"
  }
}
```

แนะนำสร้าง TypeScript models:

```ts
export interface AppProfile {
  id: string;
  email: string;
  username: string | null;
  full_name: string | null;
  avatar_url: string | null;
  password_enabled: boolean;
  created_at: string;
  updated_at: string;
}

export type IngestionChannel =
  | 'GMAIL_API'
  | 'MICROSOFT_GRAPH'
  | 'DIRECT_UPLOAD';

export interface IngestionRoute {
  emailDomain: string;
  channel: IngestionChannel;
  connectionProvider: 'GOOGLE' | 'MICROSOFT' | null;
  requiresMailConnection: boolean;
  nextAction:
    | 'CONNECT_GOOGLE_MAIL'
    | 'CONNECT_MICROSOFT_MAIL'
    | 'UPLOAD_PDF';
}

export interface CurrentUserResponse {
  user: {
    id: string;
    email: string;
  };
  profile: AppProfile | null;
  usernameLoginEnabled: boolean;
  ingestionRoute: IngestionRoute;
}
```

## 8. Username/Password Login

ผู้ใช้ใหม่ต้อง Login ด้วย Social Provider ก่อน ระบบสร้าง `full_name` และ Username เริ่มต้นจากชื่อ Provider ให้ทันที หากชื่อซ้ำระบบจะเติม suffix เพื่อรักษา Username ให้ไม่ซ้ำ แต่ Username Login จะยังใช้ไม่ได้จนกว่าผู้ใช้ตั้ง Password

### ตั้งหรือแก้ Username/Password

```http
PATCH /api/v1/auth/credentials
Authorization: Bearer ACCESS_TOKEN
Content-Type: application/json

{
  "username": "portfolio.user",
  "password": "strong-password"
}
```

ครั้งแรกส่งทั้งสองค่า หรือครั้งต่อไปส่งเพียงค่าที่ต้องการเปลี่ยนได้ เช่น `{ "username": "new username" }` หรือ `{ "password": "new-strong-password" }`

เมื่อสำเร็จ Frontend ต้องอัปเดต Store จาก response:

```json
{
  "profile": {
    "username": "portfolio.user",
    "password_enabled": true
  },
  "usernameLoginEnabled": true
}
```

กติกา Username:

- ความยาว 3–50 ตัวอักษร
- ใช้เป็นชื่อแสดง Profile และชื่อสำหรับ Login
- รองรับภาษาไทยและช่องว่าง
- ห้ามมี `@`
- Backend ตัดช่องว่างหัวท้าย รวมช่องว่างซ้ำ และเปลี่ยนเป็นตัวพิมพ์เล็ก

กติกา Password ปัจจุบัน:

- ความยาว 8–72 ตัวอักษร

การตั้ง Password เป็นตัวเลือก ไม่ใช่เงื่อนไขก่อนเข้า Dashboard

### Login ด้วย Username

```http
POST /api/v1/auth/login-username
Content-Type: application/json

{
  "username": "portfolio.user",
  "password": "strong-password"
}
```

Backend ตอบ Supabase session กลับมา หลัง Login สำเร็จ Frontend ต้องให้ Supabase client รับผิดชอบ session lifecycle แล้วเรียก `/auth/me`

## 9. Profile Display Rules

Navbar, Profile Menu, Dashboard และ Settings ต้องอ่าน Profile จาก Auth Store ที่มาจาก `/auth/me`:

```html
<img [src]="user.profile.avatar_url || defaultAvatar" alt="Profile" />
<span>{{ user.profile.username || user.profile.full_name || user.user.email }}</span>
```

ลำดับ fallback ที่แนะนำ:

```text
profile.username
→ profile.full_name
→ user.email
```

อย่าเปลี่ยนชื่อหรือรูปตาม Provider ล่าสุดโดยอัตโนมัติ

ชื่อและรูปจาก Social Provider เป็นข้อมูลแบบ read-only ในระบบปัจจุบัน Frontend ต้องไม่แสดงปุ่มแก้ชื่อหรืออัปโหลดรูป Profile

### แก้ Username หรือ Password

```http
PATCH /api/v1/auth/credentials
Authorization: Bearer ACCESS_TOKEN
Content-Type: application/json

{
  "username": "new.username"
}
```

Endpoint เดียวกันใช้ได้ทั้งครั้งแรกและครั้งต่อไป Frontend ต้องนำ `profile` จาก response ไปแทนค่าใน Auth Store และห้ามแก้ตาราง `profiles` ผ่าน Supabase client โดยตรง

## 10. Multi-provider Scenario

กรณีผู้ใช้ทำดังนี้:

```text
1. Login Google ด้วย user@gmail.com
2. Login Facebook ด้วย user@gmail.com
```

ผลที่ต้องการ:

- Supabase อาจเชื่อมเป็น User ID เดียว
- `/auth/me` ต้องคืน Profile เดิม
- ชื่อและรูปใน UI ต้องไม่เปลี่ยนตาม Facebook
- Username Login ที่เคยเปิดไว้ต้องยังใช้งานได้
- Ingestion route ยังคงอิง Email ของบัญชี

Frontend ไม่ควรสร้าง Profile ใหม่เมื่อ Provider เปลี่ยน และไม่ควรส่ง Social metadata ไปเขียน Profile อัตโนมัติ

## 11. Auth State Handling

ควร subscribe Supabase auth state:

```ts
this.supabase.auth.onAuthStateChange((event, session) => {
  switch (event) {
    case 'SIGNED_IN':
    case 'TOKEN_REFRESHED':
      // โหลด /auth/me เมื่อจำเป็น
      break;
    case 'SIGNED_OUT':
      this.authStore.clear();
      this.router.navigateByUrl('/login');
      break;
  }
});
```

ระวังไม่เรียก `/auth/me` ซ้ำจากทั้ง callback, guard และ auth listener พร้อมกัน ควรมี service กลางที่ cache/in-flight share request

## 12. Dime PDF Upload Preview

Backend มี endpoint สำหรับทดสอบอัปโหลดและอ่านข้อความจาก Dime PDF แล้ว:

```http
POST /api/v1/trades/upload-preview
Authorization: Bearer ACCESS_TOKEN
Content-Type: multipart/form-data
```

Endpoint นี้เป็น **Structured Preview** และยังไม่บันทึก Transaction โดยทำงานดังนี้:

```text
รับ PDF จากผู้ใช้
→ เก็บไฟล์ใน Memory ชั่วคราว
→ ตรวจชนิดและขนาดไฟล์
→ ใช้ pdfPassword เปิดไฟล์ (ถ้ามี)
→ แยกข้อความ
→ ดึงเฉพาะคำสั่งซื้อขาย ค่าธรรมเนียม ภาษี และยอดรวม
→ ตรวจความถูกต้องของยอดเงิน
→ คืน Structured JSON
→ ไม่คืน Raw Text และไม่บันทึก PDF, Password หรือ Transaction
```

### Request fields

| Field | Required | รายละเอียด |
|---|---:|---|
| `file` | ใช่ | PDF หนึ่งไฟล์ ขนาดไม่เกิน 10 MB |
| `pdfPassword` | ไม่ | รหัสเปิด Dime PDF ความยาวไม่เกิน 128 ตัวอักษร |

ชื่อ field ต้องเป็น `file` และ `pdfPassword` ตรงตามนี้

ตัวอย่าง Angular service:

```ts
export interface PdfUploadPreviewResponse {
  file: {
    name: string;
    size: number;
    mimeType: string;
    pageCount: number | null;
  };
  document: {
    type: 'DIME_OFFSHORE_CONFIRMATION_NOTE';
    documentNumber: string | null;
    taxInvoiceNumber: string | null;
    accountNumber: string | null;
    issueDate: string | null;
    effectiveDate: string | null;
    deduplicationKey: string | null;
  };
  orders: Array<{
    orderId: string;
    tradeDate: string | null;
    settlementDate: string;
    transactionCode: 'BUY' | 'SEL' | 'SELL' | 'REW' | 'EXC' | 'EXP';
    transactionType: 'BUY' | 'SELL' | 'REWARD' | 'EXERCISE_CALL' | 'EXERCISE_PUT';
    symbol: string;
    exchange: string;
    units: number;
    unitPrice: number;
    currency: string;
    grossAmount: { foreign: number; thb: number };
    feeIncludeVat: { foreign: number; thb: number };
    withholdingTax: { foreign: number; thb: number };
    totalAmount: { foreign: number; thb: number };
  }>;
  summary: {
    currency: 'THB';
    totalBuy: number;
    totalSell: number;
    totalFeeExcludeVat: number;
    discount: number | null;
    totalFeeAfterDiscountExcludeVat: number | null;
    totalVat: number;
    withholdingTax: number;
  } | null;
  // Offshore only: use display for UI, never calculation for paid fees.
  display: {
    source: 'PDF';
    currency: 'THB';
    totalBuy: number | null;
    totalSell: number | null;
    totalFeeExcludeVat: number | null;
    discount: number | null;
    totalFeeAfterDiscountExcludeVat: number | null;
    totalVat: number | null;
    withholdingTax: number | null;
    totalFeeIncludeVatAfterDiscount: number | null;
    totalFeesAndTaxes: number | null;
    derivedFields: string[];
  };
  calculation: {
    totalFeeIncludeVatAfterDiscount: number | null;
    totalFeesAndTaxes: number | null;
    netCashFlow: number | null;
    cashFlowType: 'CASH_IN' | 'CASH_OUT' | 'NONE' | null;
  };
  validation: {
    isValid: boolean;
    warnings: Array<{ code: string; orderId?: string }>;
  };
  diagnostics: {
    validation: { isValid: boolean; warnings: Array<{ code: string; orderId?: string }> };
  };
}

uploadPdfPreview(file: File, pdfPassword?: string) {
  const formData = new FormData();
  formData.append('file', file);

  if (pdfPassword) {
    formData.append('pdfPassword', pdfPassword);
  }

  return this.http.post<PdfUploadPreviewResponse>(
    `${environment.apiUrl}/trades/upload-preview`,
    formData,
  );
}
```

ห้ามกำหนด `Content-Type: multipart/form-data` ด้วยตัวเองใน Angular เพราะ Browser ต้องสร้าง `boundary` ให้ แต่ Auth interceptor ยังต้องแนบ `Authorization` ตามปกติ

### Response

```json
{
  "file": {
    "name": "confirmation-note.pdf",
    "size": 245801,
    "mimeType": "application/pdf",
    "pageCount": 2
  },
  "document": {
    "type": "DIME_OFFSHORE_CONFIRMATION_NOTE",
    "documentNumber": "2026082500095303",
    "taxInvoiceNumber": "DIMEOS20260825095303",
    "accountNumber": "80000834017",
    "issueDate": "2026-08-25",
    "effectiveDate": "2026-08-24",
    "deduplicationKey": "DIME_OFFSHORE_CONFIRMATION_NOTE:2026082500095303"
  },
  "orders": [
    {
      "orderId": "219884",
      "tradeDate": "2026-08-24",
      "settlementDate": "2026-08-25",
      "transactionCode": "BUY",
      "transactionType": "BUY",
      "symbol": "RKLB",
      "exchange": "XNAS",
      "units": 0.4331164,
      "unitPrice": 69.15,
      "currency": "USD",
      "grossAmount": { "foreign": 29.95, "thb": 972.87 },
      "feeIncludeVat": { "foreign": 0.05, "thb": 1.62 },
      "withholdingTax": { "foreign": 0, "thb": 0 },
      "totalAmount": { "foreign": 30, "thb": 974.49 }
    }
  ],
  "summary": {
    "currency": "THB",
    "totalBuy": 974.49,
    "totalSell": 0,
    "totalFeeExcludeVat": 1.52,
    "discount": 0,
    "totalFeeAfterDiscountExcludeVat": 1.52,
    "totalVat": 0.11,
    "withholdingTax": 0
  },
  "calculation": {
    "totalFeeIncludeVatAfterDiscount": 1.63,
    "totalFeesAndTaxes": 1.63,
    "netCashFlow": -974.49,
    "cashFlowType": "CASH_OUT"
  },
  "validation": {
    "isValid": true,
    "warnings": []
  }
}
```

- `foreign` คือจำนวนเงินตาม `currency` ของรายการ เช่น USD
- `thb` คือจำนวนเงินบาทที่ Dime แสดงในเอกสาร
- `tradeDate` คือวันที่ซื้อขายจริงจาก `วันที่คำสั่งมีผล / Effective Date` ให้ Frontend ใช้เป็นวันที่ของรายการ
- `settlementDate` คือ `วันที่ครบกำหนดชำระ / Settlement Date` ไม่ใช่วันที่ซื้อขาย
- `documentNumber` คือเลข `No.` ของ Confirmation Note ใช้เป็นเลขหลักสำหรับตรวจเอกสารซ้ำต่อผู้ใช้
- `taxInvoiceNumber` คือเลข `Tax Invoice No.` สำหรับอ้างอิงใบกำกับภาษี
- `deduplicationKey` คือ key มาตรฐานที่ Backend สร้างสำหรับตรวจเอกสารซ้ำต่อผู้ใช้
- `transactionCode` คือรหัสต้นฉบับจาก Dime ส่วน `transactionType` คือค่าที่ normalize แล้ว:
  `BUY → BUY`, `SEL/SELL → SELL`, `REW → REWARD`, `EXC → EXERCISE_CALL`, `EXP → EXERCISE_PUT`

### Mutual Fund Confirmation Note

เมื่อ `document.type` เป็น `DIME_MUTUAL_FUND_CONFIRMATION_NOTE` จะได้รายการกองทุน
และยอดรวมในสกุลบาท โดยใช้ endpoint อัปโหลดเดิม

```json
{
  "document": {
    "type": "DIME_MUTUAL_FUND_CONFIRMATION_NOTE",
    "documentNumber": "DN 202608141359",
    "taxInvoiceNumber": "DIMEMF20260811002540",
    "accountNumber": "101738738454892",
    "issueDate": "2026-08-11",
    "effectiveDate": "2026-08-11",
    "deduplicationKey": "DIME_MUTUAL_FUND_CONFIRMATION_NOTE:DN-202608141359"
  },
  "orders": [
    {
      "orderId": "2202608110004728",
      "tradeDate": "2026-08-11",
      "transactionCode": "SUB",
      "transactionType": "SUBSCRIPTION",
      "fundName": "SCBS&P500",
      "units": 3.3902,
      "navPerUnit": 29.4963,
      "currency": "THB",
      "totalAmount": 100,
      "feeIncludeVat": 0.49
    }
  ],
  "summary": {
    "currency": "THB",
    "totalSubscription": 100,
    "totalSwitchIn": 0,
    "totalRedemption": 0,
    "totalSwitchOut": 0,
    "totalFeeExcludeVat": 0.46,
    "totalVat": 0.03,
    "totalFeeIncludeVat": 0.49,
    "brokerageExpensePaidToFund": 0.04
  },
  "calculation": {
    "netCashFlow": -100,
    "cashFlowType": "CASH_OUT"
  },
  "validation": {
    "isValid": true,
    "warnings": []
  }
}
```

รหัสรายการกองทุนถูก normalize ดังนี้:
`SUB → SUBSCRIPTION`, `RED → REDEMPTION`, `SWI → SWITCH_IN`, `SWO → SWITCH_OUT`

### Thai Stock Confirmation Note

เมื่อ `document.type` เป็น `DIME_THAI_STOCK_CONFIRMATION_NOTE` จะได้รายการหุ้นไทย
พร้อมวันที่ซื้อขาย วันที่ชำระ ค่าธรรมเนียม และ VAT

```json
{
  "document": {
    "type": "DIME_THAI_STOCK_CONFIRMATION_NOTE",
    "documentNumber": "TH2026090300011218",
    "taxInvoiceNumber": "DIMETH2026090300011218",
    "accountNumber": "97507514",
    "issueDate": "2026-09-03",
    "effectiveDate": "2026-09-03",
    "deduplicationKey": "DIME_THAI_STOCK_CONFIRMATION_NOTE:TH2026090300011218"
  },
  "orders": [
    {
      "orderId": "031642183181",
      "tradeDate": "2026-09-03",
      "settlementDate": "2026-09-07",
      "transactionCode": "BUY",
      "transactionType": "BUY",
      "symbol": "ASK",
      "units": 5,
      "pricePerShare": 10.2,
      "currency": "THB",
      "grossAmount": 51,
      "feeExcludeVat": 0.08,
      "vat": 0.01,
      "totalAmount": 51.09
    }
  ],
  "summary": {
    "currency": "THB",
    "totalBuy": 51.09,
    "totalSell": 0,
    "totalFeeExcludeVat": 0.08,
    "totalVat": 0.01,
    "netCustomerAmount": 51.09,
    "netCustomerDirection": "PAID"
  },
  "calculation": {
    "totalFeesAndTaxes": 0.09,
    "netCashFlow": -51.09,
    "cashFlowType": "CASH_OUT"
  },
  "validation": {
    "isValid": true,
    "warnings": []
  }
}
```

รหัสรายการหุ้นไทย: `BUY → BUY`, `SEL/SELL → SELL`, `REW → REWARD`
- สำหรับหุ้นนอก (`DIME_OFFSHORE_CONFIRMATION_NOTE`) ยอดแสดงผลให้ใช้ `preview.display` ไม่ใช้ `preview.calculation` และไม่ลบ discount ซ้ำ: `display.totalFeeIncludeVatAfterDiscount` รวมจาก **totalFeeAfterDiscountExcludeVat ที่ PDF ระบุ + totalVat** ส่วน `display.totalFeesAndTaxes` เพิ่ม withholdingTax ที่ PDF ระบุ เป็นยอดรวมจากข้อมูลในเอกสาร ไม่ใช่ค่าที่อ่านตรงจากช่องเดียว จึงระบุชื่อไว้ใน `derivedFields`
- ตัวอย่าง Angular (ใช้เงื่อนไข null ไม่ใช้ `?? 0` เพราะยอดอ่านไม่ได้ไม่ใช่ศูนย์):
  `{{ preview.display?.totalFeeIncludeVatAfterDiscount == null ? 'อ่านยอดไม่ได้' : formatAmount(preview.display.totalFeeIncludeVatAfterDiscount) }}`
- `summary` ยังคงข้อมูลเอกสาร, `calculation` ยังคงการคำนวณอิสระเดิมสำหรับตรวจสอบเท่านั้น ห้ามใช้เป็น fallback แทนยอด PDF ที่อ่านไม่พบ ต้องแสดงสถานะอ่านยอดไม่ได้ หากเป็นเอกสารรุ่นเก่าที่ไม่มีส่วนลดและไม่มีช่องยอดหลังส่วนลด จะใช้ค่าธรรมเนียมก่อน VAT ที่เอกสารระบุและส่วนลด 0; แต่ถ้ามีหัวข้อส่วนลดแล้วอ่านตัวเลขไม่พบจะคืน null ไม่เดายอด
- `FEE_AFTER_DISCOUNT_MISMATCH` เก็บเฉพาะใน `diagnostics.validation` สำหรับผู้พัฒนา ไม่ส่งใน `validation.warnings` ที่หน้า Preview ใช้ จึงไม่ทำให้ public `validation.isValid` เป็น false เพียงเพราะสูตรส่วนลดไม่ตรง แต่ยังตรวจสอบความผิดปกติชนิดอื่นตามเดิม ห้ามสรุปจาก mismatch ว่าเป็นสิทธิ์ฟรีค่าคอมรายการแรกของเดือนโดยอัตโนมัติ
- อย่านำ `diagnostics.validation` มาแสดงเป็น popup/คำเตือนหรือใช้บล็อก Preview ทั่วไป calculation/diagnostics เก็บแยกใน response และในเอกสาร Preview หลัง SQL 007 แล้ว ไม่ใช้ยอดคำนวณทับยอด PDF
- หุ้นไทยและกองทุนยังใช้ `summary` ตาม schema เดิม ไม่มี `display` หรือ `diagnostics` ชุดนี้ ให้แยก UI ตาม `document.type`

### Monthly Statement (ปิดชั่วคราว / ฟีเจอร์ในอนาคต)

เอกสาร Dime Gold และประเภทอื่นที่ไม่รองรับจะไม่ถูกเลือกเป็น offshore เพียงเพราะมีหัวข้อ Confirmation Note อีกต่อไป Backend ตรวจรหัส DIMEOS/DIMETH/DIMEMF จากเนื้อหา การอัปโหลดตรงที่ไม่รองรับคืน `422 DIME_DOCUMENT_UNSUPPORTED` ส่วน Gmail จะไม่ส่งรายการที่ไม่รองรับกลับมาแสดง (ไม่ใช่รายการ PARSE_FAILED) ข้อผิดพลาดจาก Confirmation ที่รองรับยังแสดงตามปกติ

ตอนนี้รองรับเฉพาะ Confirmation ของหุ้นนอก หุ้นไทย และกองทุน การอัปโหลด Monthly จะตอบ HTTP `422` พร้อม `error.code = DIME_MONTHLY_TEMPORARILY_DISABLED` ให้แสดงว่า “ปิดการอ่าน Monthly ชั่วคราว กรุณาใช้ Confirmation” และซ่อนตัวเลือก Monthly ใน UI ไม่ใช่แจ้งว่า PDF เสีย

เก็บ parser และตัวอย่างด้านล่างไว้เป็นแนวทางอนาคตเท่านั้น ยังไม่มี endpoint สาธารณะที่คืน Preview Monthly เมื่อกลับมาเปิดใช้งาน `document.type` เป็น `DIME_MONTHLY_STATEMENT` จะมี `overview`, `assetAllocation` และ `holdings` แทน `orders` และ `summary` ของ Confirmation Note

```json
{
  "document": {
    "type": "DIME_MONTHLY_STATEMENT",
    "documentNumber": null,
    "statementMonth": "2026-06",
    "asOfDate": "2026-06-30",
    "accountNumber": "80000834017",
    "baseCurrency": "USD",
    "exchangeRate": {
      "from": "USD",
      "to": "THB",
      "rate": 33.1,
      "source": "BOT"
    },
    "deduplicationKey": "DIME_MONTHLY_STATEMENT:80000834017:2026-06"
  },
  "overview": {
    "portfolioValue": { "usd": 1441.35, "thb": 47714.61 },
    "cashBalance": { "usd": 31.84, "thb": 1054.04 },
    "totalAccountValue": {
      "usd": 1473.19,
      "thb": 48768.65,
      "derived": true
    },
    "investmentReturn": {
      "percentage": 12.04,
      "usd": 154.89,
      "thb": 5127.62,
      "includesDividends": false
    }
  },
  "assetAllocation": {
    "assetClasses": [],
    "sectors": []
  },
  "holdings": [],
  "validation": {
    "isValid": true,
    "warnings": []
  }
}
```

- `portfolioValue` คือมูลค่าหลักทรัพย์ในพอร์ต
- `cashBalance` คือเงินสดที่ยังอยู่ในบัญชี Dime
- `totalAccountValue` เป็นค่าที่ Backend คำนวณจากสองค่าข้างต้น
- Monthly Statement รอบนี้ยังไม่ส่งข้อมูลจุดกราฟย้อนหลัง
- Monthly Statement ไม่มีเลข `No.` ในเอกสาร จึงใช้เลขบัญชีร่วมกับเดือนรายงานสร้าง `deduplicationKey`
- `totalFeesAndTaxes` คือค่าธรรมเนียมหลังหักส่วนลดรวม VAT แล้วบวก Withholding Tax
- `netCashFlow < 0` หมายถึงเงินออกจากบัญชี และ `> 0` หมายถึงเงินเข้า
- `validation.warnings` แจ้งยอดที่ไม่ตรงกัน แต่หลัง SQL 008 ไม่บล็อกการยืนยัน Import จาก isValid=false ให้ใช้ record.canImport แทน และแสดง calculatedValue เทียบ pdfValue จากคำเตือนเมื่อมี ค่าคำนวณรวมเก็บแยกใน calculation.investmentTotals ไม่ทับ display/summary ตาม PDF
- `pageCount` อาจเป็น `null` ถ้า parser ไม่คืนข้อมูลจำนวนหน้า

### UI flow ที่แนะนำ

```text
เลือก PDF
→ ถามรหัสเปิดไฟล์ (ถ้ามี)
→ กด Preview
→ แสดง Loading
→ สำเร็จ: แสดงตาราง Orders และสรุปยอดซื้อ/ขาย/ค่าธรรมเนียม/ภาษี
→ ถ้า validation ไม่ผ่าน: แสดงคำเตือนเปรียบเทียบยอด แต่ยังให้ยืนยัน Import เมื่อ record.canImport=true
→ รหัสผิด: ให้กรอกใหม่
→ ไม่มีข้อความ: แจ้งว่าไฟล์อาจเป็นภาพสแกน
```

Frontend ห้ามเขียน `pdfPassword` หรือข้อมูลคำสั่งซื้อขายลง console, localStorage, analytics หรือ error-reporting service และควรล้างออกจาก state เมื่อออกจากหน้าหรือเลือกไฟล์ใหม่

### PDF upload errors

| HTTP | Code | การแสดงผล |
|---:|---|---|
| 400 | `PDF_FILE_REQUIRED` | กรุณาเลือกไฟล์ PDF |
| 400 | `INVALID_PDF` | ไฟล์ไม่มีโครงสร้าง PDF ที่ถูกต้อง |
| 400 | `INVALID_PDF_PASSWORD` | รูปแบบรหัส PDF ไม่ถูกต้อง |
| 400 | `UPLOAD_ERROR` | Request อัปโหลดไม่ถูกต้อง |
| 401 | `UNAUTHORIZED` | Session หมดอายุ ให้ Login ใหม่ |
| 413 | `PDF_TOO_LARGE` | ไฟล์ต้องมีขนาดไม่เกิน 10 MB |
| 415 | `PDF_FILE_REQUIRED` | รองรับเฉพาะไฟล์ PDF |
| 422 | `PDF_PASSWORD_REQUIRED` | ไฟล์มีรหัสผ่าน กรุณากรอกรหัส |
| 422 | `PDF_PASSWORD_INVALID` | รหัสเปิด PDF ไม่ถูกต้อง |
| 422 | `PDF_TEXT_NOT_FOUND` | ไม่พบข้อความ อาจเป็น PDF แบบภาพ |
| 422 | `PDF_PARSE_FAILED` | PDF เสียหรือเป็นรูปแบบที่ยังไม่รองรับ |
| 422 | `NOT_DIME_CONFIRMATION` | เอกสารไม่ใช่ Dime Confirmation Note |
| 422 | `DIME_ORDERS_NOT_FOUND` | ไม่พบตารางคำสั่งซื้อขายที่รองรับ |

## 13. Error Handling

Frontend ควรรองรับ error codes เหล่านี้:

| HTTP | Code | การแสดงผล |
|---:|---|---|
| 400 | `VALIDATION_ERROR` | Username/Password ไม่ถูกต้อง |
| 400 | `INVALID_USERNAME` | แจ้งกติกา Username |
| 400 | `INVALID_PASSWORD` | แจ้งกติกา Password |
| 400 | `PASSWORD_REQUIRED` | แจ้งให้กรอก Password |
| 401 | `UNAUTHORIZED` | ล้าง session และกลับหน้า Login |
| 401 | `INVALID_CREDENTIALS` | Username หรือ Password ไม่ถูกต้อง |
| 409 | `USERNAME_TAKEN` | ให้เลือก Username ใหม่ |
| 422 | `EMAIL_REQUIRED` | แจ้งว่าบัญชี Social ไม่มี Email ที่ใช้งานได้ |

ห้ามแสดง stack trace หรือรายละเอียด Supabase error ภายในให้ผู้ใช้เห็น

## 14. สิ่งที่ Backend ยังต้องเพิ่ม

Frontend สามารถเตรียม interface ไว้ก่อนได้ แต่ยังไม่ควรเรียก endpoint ที่ไม่มีจริง:

- Forgot/Reset Password flow
- เพิ่ม recent-authentication check ก่อนเปลี่ยน Password สำหรับ production
- Gmail connection และ sync endpoints
- Microsoft Graph connection และ sync endpoints
- Production PDF import endpoint ที่ parse และบันทึก Transaction (ปัจจุบันมีเฉพาะ Preview)

Frontend ห้าม update `profiles` ผ่าน Supabase client โดยตรง

## 15. Frontend Checklist

- [ ] Social login รองรับ Google/Facebook และ Apple เมื่อพร้อม
- [ ] Auth callback อ่าน Supabase session สำเร็จ
- [ ] HTTP interceptor แนบ Bearer access token
- [ ] เรียก `/auth/me` หลัง Login
- [ ] เก็บ `/auth/me` response ใน Auth Store กลาง
- [ ] Navbar และ Profile UI อ่านจาก `profile`
- [ ] ไม่แสดงการแก้ชื่อหรืออัปโหลดรูป Profile
- [ ] การตั้ง/แก้ Username และ Password เรียก `PATCH /auth/credentials`
- [ ] ไม่ใช้ `user_metadata` เป็น Profile หลัก
- [ ] ไม่เขียน `profiles` ตรงผ่าน Supabase client
- [ ] Username แสดงจาก `profile.username`
- [ ] หลังตั้ง Password ให้ใช้ `usernameLoginEnabled` จาก response
- [ ] Logout ผ่าน Supabase client และล้าง App Store
- [ ] รองรับ 401 โดยล้าง session
- [ ] ทดสอบ Google แล้ว Login Facebook ด้วย Email เดียวกัน
- [ ] ยืนยันว่าชื่อ รูป และ Username ไม่เปลี่ยนตาม Provider ล่าสุด
- [ ] มี PDF file picker หรือ drag-and-drop ที่รับไฟล์เดียว
- [ ] จำกัดไฟล์ PDF ไม่เกิน 10 MB ที่หน้า UI
- [ ] ส่ง `file` และ `pdfPassword` ด้วย `FormData`
- [ ] ไม่กำหนด multipart `Content-Type` เอง
- [ ] แสดง Loading และป้องกันการกด Upload ซ้ำ
- [ ] รองรับ `PDF_PASSWORD_REQUIRED` และ `PDF_PASSWORD_INVALID`
- [ ] ไม่ log หรือ persist `pdfPassword` และข้อมูลคำสั่งซื้อขาย
- [ ] แสดง Orders, Summary, Net Cash Flow และ Validation warnings จาก response
- [ ] แสดงให้ชัดว่า Preview ยังไม่ได้บันทึก Transaction
