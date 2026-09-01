# Frontend Auth & Profile Integration Guide

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

## 12. Error Handling

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

## 13. สิ่งที่ Backend ยังต้องเพิ่ม

Frontend สามารถเตรียม interface ไว้ก่อนได้ แต่ยังไม่ควรเรียก endpoint ที่ไม่มีจริง:

- Forgot/Reset Password flow
- เพิ่ม recent-authentication check ก่อนเปลี่ยน Password สำหรับ production
- Gmail connection และ sync endpoints
- Microsoft Graph connection และ sync endpoints
- Direct PDF upload endpoint

Frontend ห้าม update `profiles` ผ่าน Supabase client โดยตรง

## 14. Frontend Checklist

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
