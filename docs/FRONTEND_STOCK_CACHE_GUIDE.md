# Frontend: cache ราคาหุ้นตามช่วงตลาดสหรัฐฯ

Endpoint เดิม: GET /api/v1/trades/holdings?includeMarket=true (เพิ่ม includeFx/includeLogos ได้ตามเดิม) พร้อม Supabase Bearer token ไม่มี SQL ใหม่ ไม่ต้อง resync/reimport PDF ต้นทุนจาก PDF และสูตรกำไรขาดทุนไม่เปลี่ยน

## พฤติกรรม

| ช่วง | Backend ทำอะไรเมื่อ Frontend ขอข้อมูล |
| --- | --- |
| ตลาดเปิดตามตาราง | ใช้ราคาใน cache ไม่เกิน 15 นาที หรือค่า STOCK_PRICE_CACHE_TTL_SECONDS ที่ตั้งไว้; expiresAt ไม่เกินเวลาปิด session |
| เพิ่งปิดตลาด | ถ้า snapshot มาจากก่อนปิด จะขอใหม่แม้ยังไม่ครบ TTL; ภายใน 5 นาทีแรก cache ได้ถึง close + 5 นาที แล้วขอใหม่เมื่อมี request |
| หลังปิดเกิน 5 นาทีและราคาเหมาะสม | ใช้ snapshot จนเปิด session ถัดไป ไม่ refresh ทุก 15 นาที |
| ตลาดปิดแต่ยังไม่มีหุ้นนั้นใน cache | ขอราคามาเก็บ โดยใช้กติกาหลังปิดเดียวกัน |
| เปิดรอบใหม่ | snapshot ที่ขอมาจากก่อนเปิดหมดอายุทันที; request แรกจะขอราคาใหม่ แล้วกลับไปใช้ TTL ช่วงเปิด |
| Calendar ไม่ครอบคลุม | ใช้ TTL ปกติ ไม่เดาวันหยุด/เวลาเปิดใหม่ |
| API ล้มเหลว/โควต้าเต็ม | ใช้ stale fallback ที่อยู่ในขอบเขต พร้อม warning/retryAt หรือ UNAVAILABLE ถ้าไม่มีราคาที่ใช้ได้ |

ทั้งหมดเป็น on-demand ไม่มี timer, scheduler, polling หรือ push จาก Backend: หากไม่มี request หลังปิด ก็จะไม่มี API call หลังปิดเช่นกัน request แรกหลังจากนั้นจะทำ refresh ที่ยังค้างอยู่ ไม่จำเป็นต้อง refresh ถี่ขณะตลาดปิด

ราคาหลังปิดที่ถือว่าเหมาะสมต่อการเก็บยาว ต้องขอหลังเวลาปิดอย่างน้อย 5 นาที และ priceAt ต้องไม่เก่ากว่านาทีสุดท้ายก่อนปิด session ล่าสุด หาก provider ยังส่งราคาเก่ากว่านั้น จะคืน cachePolicy=POST_CLOSE_REFRESH_PENDING, isStale=true, warning=POST_CLOSE_PRICE_PENDING และใช้ TTL สั้นเพื่อลองใหม่เมื่อมี request ไม่ freeze ราคาวันก่อนทั้งคืน หุ้นที่ไม่มี tick ช่วงท้ายตลาดอาจอยู่ในสถานะนี้ต่อได้

นี่คือ snapshot จาก quote API ไม่ใช่การรับรองราคาปิดทางการ ไม่สามารถยืนยันว่าไม่มี pre/post-market trade เพราะ provider ไม่จำแนก session ใน payload นี้ ไม่คำนวณ after-hours แบบ realtime

## ฟิลด์ใหม่ใน items[].marketValuation.quote

| ฟิลด์ | ความหมาย |
| --- | --- |
| requestedAt | เวลาที่ Backend เริ่มขอ quote นี้ ใช้แยก request ก่อน/หลังจุดเปลี่ยน session |
| priceAt | เวลาอ้างอิงราคาจาก Finnhub ไม่ได้เปลี่ยนตามเวลาเปิดหน้าพอร์ต |
| fetchedAt | เวลาที่ได้รับและเก็บ snapshot สำเร็จ |
| expiresAt | เวลาหมดอายุจริงตามนโยบาย session ไม่จำเป็นต้องเท่ากับ fetchedAt + 15 นาที |
| cachePolicy | MARKET_OPEN_TTL / MARKET_CLOSED_UNTIL_OPEN / POST_CLOSE_REFRESH_PENDING / CALENDAR_FALLBACK_TTL |
| postCloseRefreshPending | ยังรอ snapshot หลังปิดที่เหมาะสมหรือไม่ ไม่ได้หมายความว่ามี background job กำลังทำงาน |
| marketSchedule | ตาราง session ที่คำนวณสำหรับเวลาที่ตอบ request นี้ |

fromCache/isStale/warning/retryAt ยังใช้เหมือนเดิม คืนข้อมูลเวลาของ snapshot เดิมเมื่อใช้ cache ไม่เปลี่ยน fetchedAt เพื่อให้ดูสด

isStale=false ตอนตลาดปิดหมายถึง snapshot ยังใช้ได้ตามนโยบาย ไม่ได้หมายความว่าเพิ่งมีการซื้อขายหรือราคา realtime ส่วน cacheTtlSeconds ใน offshoreValuation ยังคงเป็น TTL ช่วงเปิดตลาด (default 900) ให้ใช้ quote.expiresAt สำหรับเวลาหมดอายุจริง

ตัวอย่างบางส่วน หลังปิดตลาดวันอังคาร 20 ต.ค. 2026 (เวลาตัวอย่างเป็น UTC):

~~~json
{
  "status": "AVAILABLE",
  "source": "FINNHUB",
  "symbol": "NVDA",
  "micCode": "XNAS",
  "currency": "USD",
  "price": 216.47,
  "priceAt": "2026-10-20T20:00:00.000Z",
  "requestedAt": "2026-10-20T20:10:00.000Z",
  "fetchedAt": "2026-10-20T20:10:00.000Z",
  "expiresAt": "2026-10-21T13:30:00.000Z",
  "fromCache": true,
  "isStale": false,
  "cachePolicy": "MARKET_CLOSED_UNTIL_OPEN",
  "postCloseRefreshPending": false,
  "session": "PROVIDER_QUOTE",
  "marketOpen": null,
  "marketSchedule": {
    "source": "US_EQUITIES_SCHEDULE",
    "state": "CLOSED",
    "timeZone": "America/New_York",
    "calendarThrough": "2028-12-31",
    "evaluatedAt": "2026-10-20T21:00:00.000Z",
    "sessionDate": "2026-10-20",
    "sessionOpenAt": "2026-10-20T13:30:00.000Z",
    "sessionCloseAt": "2026-10-20T20:00:00.000Z",
    "lastCloseAt": "2026-10-20T20:00:00.000Z",
    "nextOpenAt": "2026-10-21T13:30:00.000Z"
  }
}
~~~

marketSchedule.state เป็น OPEN/CLOSED/UNKNOWN ตามตาราง core session ไม่ใช่สถานะ live จาก exchange sessionDate/openAt/closeAt คือ session ของวันที่ New York ปัจจุบัน ถ้าวันหยุด/weekend จะเป็น null ส่วน lastCloseAt คือ session ล่าสุดที่ปิดไปแล้ว nextOpenAt คือการเปิดครั้งถัดไปในอนาคต (หากตอนนี้เปิดอยู่ จะหมายถึงรอบวันทำการถัดไป)

quote.marketOpen ยังคง null เพราะ Finnhub quote ไม่ส่งค่านี้มา อย่าเปลี่ยนเป็นการยืนยันเปิด/ปิดจริงจากตาราง อาจมี emergency closure, halt หรือการเปลี่ยนตารางที่ local calendar ยังไม่ทราบ

UNAVAILABLE อาจไม่มี requestedAt/marketSchedule/expiresAt เพราะยังไม่มี snapshot สำเร็จ อย่า assume ว่าฟิลด์เหล่านี้มีทุกครั้ง

## Frontend ควรปรับอะไร

1. ใช้ expiresAt ที่ Backend ส่งมา ไม่คำนวณ fetchedAt + 900 วินาทีเอง
2. เปิด/กลับหน้าพอร์ต กดรีเฟรช หรือบันทึกธุรกรรมสำเร็จ ยังเรียก endpoint ได้ตามเดิม แม้ราคายัง cache อยู่ Backend จะคำนวณจากจำนวนหุ้น/ต้นทุนล่าสุดของผู้ใช้
3. ถ้าตั้ง auto-refresh บนหน้าพอร์ต ให้ใช้ expiresAt เป็นแนวทางครั้งถัดไป เฉพาะแท็บที่ active และเปิดหน้าพอร์ตอยู่ ไม่เรียกทันทีวนซ้ำเมื่อเวลาหมดอายุแล้วแต่ provider ล้มเหลว: เคารพ retryAt และทำ backoff อย่างน้อย 60 วินาทีเมื่อไม่มี retryAt
4. ตลาดปิดที่ cachePolicy=MARKET_CLOSED_UNTIL_OPEN ไม่จำเป็นต้อง polling ราคาเป็นรอบ 15 นาที รอถึง expiresAt/กลับเข้าแท็บแล้วขอใหม่ได้ แต่ request แรกหลังเปิดยังอาจได้ quote timestamp เดิมจาก provider ได้ ให้แสดง priceAt ตามจริง
5. ถ้า postCloseRefreshPending=true ให้บอกว่าเป็น snapshot ที่ยังรออัปเดตหลังปิด ไม่ติดป้ายว่าเป็นราคาปิดสุดท้าย
6. แสดงเวลาราคาเป็น Asia/Bangkok ได้ด้วย Intl.DateTimeFormat อย่าบวกชั่วโมงเองหรือ hardcode ตลาดเปิด 20:30/21:30 ไทยตลอดปี
7. แยก badge ตลาดปิดตามตาราง ออกจาก badge ราคาเก่า: ราคาปิดที่ cache ถูกนโยบายมี fromCache=true และ isStale=false ได้
8. ถ้า snapshot ถูกคืนด้วย isStale=true/warning ให้แสดงความเก่า/เวลาราคาโดยไม่เปลี่ยนค่า null เป็น 0
9. Frontend ไม่ต้องเพิ่ม API key, market-status endpoint หรือ force-refresh parameter และไม่ควรตั้ง timer ยิงตลาดปิดทุกหุ้นแยกกัน

## Calendar และขอบเขต

ใช้ timezone America/New_York รองรับ DST และปฏิทินวันหยุด/วันปิดเร็ว 2026–2028 ตาม [NYSE calendar](https://www.nyse.com/trade/hours-calendars) เป็น baseline core-session สำหรับตลาดสหรัฐฯ ที่โค้ดรองรับ ไม่ได้เรียก Finnhub market-status/holiday เพิ่ม จึงไม่เพิ่มโควต้า API สำหรับตรวจเวลา

นอกช่วงที่หาปิดล่าสุดและเปิดถัดไปได้ครบ จะส่ง UNKNOWN และกลับไป TTL ปกติ ต้องอัปเดต calendar ก่อนหมดช่วงรองรับ และต้องปรับเมื่อมีประกาศเปลี่ยนตาราง/วันปิดพิเศษ ไม่ใช่การตรวจ trading halt แบบ realtime

snapshot ที่ freeze ตามนโยบายตลาดปิดเก็บผ่าน weekend/holiday ได้เกิน 72 ชั่วโมง แต่ทั้งอายุ cache และราคาไม่เกินขอบเขต 7 วัน; หลังเปิดและ refresh ไม่สำเร็จ stale fallback ปกติยังจำกัด 72 ชั่วโมง ไม่ยืดราคาเก่าไม่สิ้นสุด โลโก้/ข่าว/Frankfurter ยังใช้นโยบายเดิม

Cache ยังเป็น process-local memory ใช้ร่วมกันเฉพาะข้อมูลตลาด ไม่เก็บจำนวนหุ้น/ต้นทุนส่วนตัว restart แล้วหาย ไม่ใช่ประวัติราคาบนฐานข้อมูล
