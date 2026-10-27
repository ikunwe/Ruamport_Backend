# Frontend state/cache สำหรับกราฟมูลค่าสินทรัพย์

เอกสารแนวทางนำไป implement ฝั่ง frontend เท่านั้น งานนี้ยังไม่เปลี่ยนโค้ด frontend, endpoint หรือพฤติกรรม Backend อ่านสัญญาข้อมูลร่วมกับ [Portfolio history guide](FRONTEND_PORTFOLIO_HISTORY_GUIDE.md)

## เป้าหมายและขอบเขต

- จำกราฟแต่ละช่วงที่เคยโหลด เมื่อกลับมาเลือกช่วงเดิมให้แสดงทันทีจาก state
- ถ้ามี ALL ที่ครบและยังสด ให้ตัด points ของ ALL เป็นช่วงสั้นโดยไม่เรียก Backend
- ไม่ preload ALL ทุกครั้งที่เข้าเว็บ โหลดเฉพาะช่วงเริ่มต้น/ช่วงที่ผู้ใช้เลือก แล้วค่อยเก็บไว้
- ไม่คำนวณจำนวนถือ, split, ราคาย้อนหลัง, FX หรือมูลค่าพอร์ตใหม่ใน frontend ใช้จุดที่ Backend คำนวณไว้เท่านั้น
- Frontend cache เก็บผลกราฟส่วนตัวต่อผู้ใช้ ต่างจาก Backend public cache ที่แชร์ราคา/NAV/FX ข้ามผู้ใช้ ห้ามแชร์ผลกราฟข้ามบัญชี

## ตำแหน่งและ key ของ state

แนะนำ service ระดับแอป เช่น Angular `providedIn: 'root'` เพื่อให้ state ไม่หายเพียงเพราะ component กราฟถูกสร้างใหม่ ใช้ Map ใน memory ไม่ใช่ localStorage/sessionStorage/IndexedDB หรือ Service Worker cache สำหรับข้อมูลพอร์ตในเวอร์ชันแรก ปิดหรือ reload เว็บแล้วโหลดใหม่ได้ตามปกติ

โครงสร้างแนะนำ (pseudocode ไม่ใช่ field ที่เพิ่มใน Backend response):

```ts
type CacheContext = {
  userId: string;
  sessionEpoch: number;
  holdingsRevision: number;
  endDate: string; // วันปัจจุบันใน Asia/Bangkok
  currency: 'THB';
  granularity: 'DAY';
  valuationBasis: 'DAILY_OBSERVATIONS_WITH_BOUNDED_CARRY_FORWARD';
};

type Entry = {
  response: PortfolioHistoryResponse;
  receivedAtMs: number;
  expiresAtMs: number;
};

// key = context ข้างต้น + range
// entries: Map<key, Entry>; จำกัดไม่เกิน 6 ranges ของ context ปัจจุบัน
// inFlight: Map<key, Promise<Entry>>; รวมคำขอซ้ำของ key เดียวกัน
```

ห้ามใช้ access token เป็น cache key หรือเก็บ token ใน entry หากอนาคตเพิ่ม filter บัญชี/ประเภทสินทรัพย์/สกุลเงิน ต้องใส่ filter ที่มีผลต่อข้อมูลใน key ด้วย ห้ามนำ cache ของ query คนละแบบมาใช้แทน

ปัจจุบัน frontend มี `holdingsRevision` ใน InvestmentImportService ใช้เป็นสัญญาณ invalidate ได้ แต่เป็น revision ภายใน client ไม่ใช่ version จากฐานข้อมูล และต้องตรวจว่าทุก workflow ที่เปลี่ยนรายการแจ้งสัญญาณนี้จริง

## ลำดับเมื่อเลือกช่วงกราฟ

1. ตรวจ session/user/revision/วันและ TTL ก่อน ห้ามเลือกข้อมูลหมดอายุหรือคนละ context
2. ถ้ามี exact range ที่ยังสดและ status COMPLETE หรือ EMPTY ให้แสดงทันที ไม่ยิง HTTP
3. ถ้าไม่มี exact range ที่ดี แต่มี ALL ที่ผ่านเกณฑ์ด้านล่าง ให้ derive view ช่วงสั้นทันที ไม่ยิง HTTP
4. ถ้ามีคำขอ key นี้กำลังทำงานอยู่ ให้ใช้ Promise เดิม ไม่ยิงซ้ำ
5. ถ้าไม่มีข้อมูลที่ใช้ได้ ให้เรียก `GET /api/v1/trades/portfolio-history?range=...` หนึ่งครั้ง แล้ว validate response ก่อนเก็บ
6. ผล INCOMPLETE/ข้อผิดพลาดใช้กติกาข้อมูลขาดและ retry ด้านล่าง ไม่ถือเป็น successful cache อายุ 15 นาที

Cache hit ไม่ต้องแสดง full-page loading หรือปิดกราฟก่อนแสดงข้อมูลใหม่ แต่ reset tooltip/activeIndex ให้ตรงกับ points ชุดที่เลือก หากกำลังโหลดช่วงใหม่ ห้ามแสดงเส้นช่วงเก่าพร้อมป้ายช่วงใหม่โดยไม่ระบุ

การเลือกช่วงสั้นแล้วขยายเป็นช่วงใหญ่กว่าเดิมโดยยังไม่มี ALL ต้องเรียก Backend ไม่ต่อราคา/ประเมินยอดเอง ส่วน Backend จะใช้ public cache และเติมเฉพาะข้อมูลที่จำเป็นตามเดิม

## ตัด ALL เป็นช่วงสั้นอย่างไร

ในเวอร์ชันแรกอนุญาต derive จาก ALL เฉพาะ `status=COMPLETE` ที่ยังสดและเป็น context เดียวกันเท่านั้น ไม่ derive จาก ALL ที่ INCOMPLETE หรือ EMPTY ให้เรียก Backend สำหรับช่วงนั้นและ cache exact range แทน (INCOMPLETE ของ ALL อาจขาดเฉพาะอดีต แต่ยังไม่ควรสรุปสถานะช่วงสั้นเองโดยไม่มีการตรวจครบ)

ใช้ `ALL.endDate` เป็นวันอ้างอิง โดยต้องตรงกับวันปัจจุบันใน Asia/Bangkok และใช้จำนวนวันเหมือน Backend ไม่ใช่เดือนปฏิทิน:

| range | ย้อนจาก endDate | จำนวนจุดสูงสุด รวมต้นและปลาย |
| --- | ---: | ---: |
| 1D | 1 วัน | 2 |
| 1W | 7 วัน | 8 |
| 1M | 30 วัน | 31 |
| 3M | 90 วัน | 91 |
| 1Y | 365 วัน | 366 |

```text
startDate = max(ALL.firstTradeDate, shiftDate(ALL.endDate, -days[range]))
points = ALL.points ที่ startDate <= point.date <= ALL.endDate
```

`shiftDate` ต้องบวก/ลบวันจาก date-only ผ่าน UTC arithmetic อย่าใช้ timezone ของ browser หรือ local DST เป็นฐาน ตรวจ YYYY-MM-DD ให้ถูกต้องก่อนเทียบ date string

ก่อน derive ต้องตรวจว่า firstTradeDate/startDate/endDate ถูกต้อง และ ALL ครอบคลุมวันเป้าหมายจริง: points เรียงวันไม่ซ้ำ มีทุกวันตั้งแต่ startDate ถึง endDate และทุกจุด isComplete=true/marketValue เป็นจำนวนที่ใช้ได้ หากไม่ผ่านให้ fallback ไปขอ exact range ห้ามเติมวันหรือสร้างค่า 0 เพื่อให้จำนวนจุดครบ `1D` ยังเป็นข้อมูลรายวัน ไม่ใช่ intraday

ใช้ local wrapper แยกข้อมูลที่ derive ออกจาก response ต้นฉบับ เช่น:

```text
view.response = copy ของ ALL โดยเปลี่ยนเฉพาะ
  range, startDate, points, status=COMPLETE, missingPointCount=0
view.meta.origin = ALL_SLICE
view.meta.sourceRange = ALL
view.meta.diagnosticsScope = ALL
view.meta.expiresAt = ALL entry.expiresAtMs
```

- อย่า mutate ALL.points หรือ objects ที่อ้างร่วมกัน เก็บ snapshot immutable หรือ clone เมื่อแปลง view
- คง calculatedAt ของต้นฉบับไว้ ห้ามเปลี่ยนเป็นเวลาที่ผู้ใช้กด เพื่อให้ดูเหมือนเพิ่งคำนวณใหม่
- คง metadata เช่น firstTradeDate, valuationBasis, limitations และ excludedFutureOrderCount ของ snapshot เดิม ไม่คำนวณขึ้นเอง
- positions/fxHistory เป็น diagnostics ของ source ALL ไม่ใช่คำขอช่วงสั้นรอบใหม่ เก็บและติดป้าย scope ไว้ ไม่ทำให้ผู้ใช้เข้าใจว่าเพิ่งตรวจ provider ใหม่ และไม่ clear errorCode/historyAvailableFrom/corporateActions เพื่อซ่อนข้อผิดพลาด
- origin/sourceRange/diagnosticsScope เป็น state ฝั่ง client เท่านั้น ไม่ใช่ Backend API fields ที่เพิ่มในงานนี้ ไม่ส่ง view กลับมาเป็นข้อมูล import
- หากเก็บ derived range เป็นอีก entry ต้องสืบทอด receivedAt/expiry ของ ALL ห้ามเริ่ม TTL ใหม่ทุกครั้งที่ตัดหรือสลับช่วง

## อายุ cache และการแสดงข้อมูลเก่า

นโยบายเริ่มต้นที่เสนอสำหรับ frontend (ยังไม่ใช่ค่าที่ Backend บังคับ):

- COMPLETE: 15 นาทีจากเวลารับ response ไม่เลื่อน expiry เมื่อมี cache hit/เปลี่ยนช่วง
- EMPTY: 1 นาที และล้างทันทีเมื่อรายการเปลี่ยน ไม่เก็บกราฟว่างไว้นานจนไม่เห็นรายการใหม่
- INCOMPLETE: เก็บแยกเพื่อแสดง partial view/diagnostics ได้ชั่วคราว เช่น 30 วินาที แต่ไม่แทนที่ complete snapshot ที่ยังเหมาะสมและไม่ใช้เป็น ALL source สำหรับ derive
- HTTP error ไม่เก็บเป็น successful entry ใช้ retry state แยกตาม key

Frontend TTL ไม่ใช่เวลาที่ provider อัปเดต: Backend public history cache ยังมี TTL 6 ชั่วโมง คำขอใหม่จาก frontend อาจได้ observation ชุดเดิม ให้แสดง calculatedAt/วันข้อมูลจริงตาม API ไม่รับประกันว่า refresh แล้วต้องเปลี่ยนยอด และไม่เพิ่ม query bypass public cache เอง

ถ้า refresh ได้ INCOMPLETE/error ขณะมี complete snapshot เดิมของ **range/context/revision/วันเดียวกัน** สามารถคงเส้นเดิมพร้อมป้าย “ข้อมูลก่อนหน้า/อัปเดตไม่สำเร็จ” และแยก diagnostics ล่าสุดได้ ไม่ผสม points จากคนละ response ให้ดูเหมือนเป็นเส้นใหม่ที่ครบ ห้ามใช้ fallback นี้ข้าม user/revision/วันหลัง invalidate

ให้ cache ที่ใช้ได้แสดงก่อนตรวจ retry block: การที่ 1M ติด cooldown ไม่ควรห้ามผู้ใช้เปิด 1W ที่มีข้อมูลใน state อยู่แล้ว ส่วนการยิง HTTP ซ้ำให้เคารพ retryAt ใน positions/fxHistory ของคำขอที่เกี่ยวข้อง หากมีหลายเวลารอ เลือกรอให้ครบเวลาที่เกี่ยวข้องก่อน retry เพื่อลดการยิงวน อย่าตั้ง global loading/retry lock จนสลับไป cache hit ไม่ได้

## ต้องล้าง cache ตอนไหน

| เหตุการณ์ | สิ่งที่ต้องทำ |
| --- | --- |
| Logout / เปลี่ยน user / session สิ้นสุดหรือ 401 ที่ยืนยันว่า session ใช้ไม่ได้ | ล้าง entries, partial/last-good views, retry และ inFlight context เดิมทันที; ไม่เก็บกราฟ user ก่อนหน้าให้คนถัดไป |
| Refresh token สำเร็จโดยยังเป็น user และสิทธิ์เดิม | ไม่ต้องล้างเพียงเพราะ token เปลี่ยน; ห้ามใช้ token เป็น key |
| Import สำเร็จแม้เพียงบางเอกสาร | เพิ่ม holdingsRevision แล้วล้างทุกช่วง/derived views ของพอร์ต ไม่ใช่เฉพาะ range ที่เปิดอยู่ |
| ลบ/แก้/ย้อน import หรือแก้รายการ/วันที่/จำนวน/บัญชีที่มีผลต่อพอร์ต | เพิ่ม revision และล้างทุกช่วงเหมือนกัน เมื่อ Backend ยืนยันการเปลี่ยนแปลงแล้ว |
| Sync/scan/preview อย่างเดียว ไม่มีการบันทึกหรือเปลี่ยนรายการ | ไม่ต้องล้างเพียงเพราะเริ่ม sync; ล้างเมื่อ import/การเปลี่ยนข้อมูลสำเร็จจริง |
| ผู้ใช้กด refresh กราฟ | invalidate ทุกช่วงและ ALL/derived ของ context นี้ แล้วขอช่วงที่กำลังเลือกหนึ่งครั้ง ไม่ preload ทั้งหกช่วง; ยังคงเคารพ provider retryAt |
| ข้ามเที่ยงคืน Asia/Bangkok / ALL.endDate ไม่ตรงวันปัจจุบัน | ล้างทุกช่วง/derived แล้วโหลดวันสิ้นสุดใหม่ ตรวจตอนเข้าหน้า/เปลี่ยนช่วง/กลับมาจาก background ด้วย ไม่พึ่ง timer อย่างเดียว |
| Entry หมด TTL | เอา entry/derived ที่อิง snapshot นั้นออกจาก fresh cache แล้วโหลดเมื่อจำเป็น ไม่ยิงทุก range พร้อมกัน |
| เปลี่ยนสกุลเงิน/filter บัญชี/ประเภท/วิธีประเมินในอนาคต | เปลี่ยน context/key ไม่ใช้ cache เก่ามาแทน |
| เปลี่ยนรูปแบบ DTO/วิธีคำนวณหลัง deploy | ล้าง cache รุ่นเก่าหรือเปลี่ยน schemaVersion ของ key; ใน memory จะหายเมื่อ reload อยู่แล้ว |

อย่าล้าง successful cache เพียงเพราะสลับ range, เข้า component ใหม่ หรือมี refresh token ปกติ ไม่เปลี่ยน `Cache-Control: no-store` ของ API เพื่อเปิด browser HTTP cache: state นี้เป็น application memory ที่ควบคุมตาม session เอง

ถ้าเปิดหลาย tab ต้องแจ้ง invalidation หลัง import/logout ข้าม tab ด้วย เช่น BroadcastChannel ส่งเพียง event ไม่ส่ง token หรือข้อมูลกราฟ ช่องทางข้ามเครื่อง/การแก้ DB จากภายนอกยังไม่มี revision จาก server ให้ตรวจทันที จึงต้องพึ่ง TTL/refresh ตามจริง ไม่อ้างว่า client cache รู้ทุกการเปลี่ยนแปลงทันที

## ป้องกันผลลัพธ์เก่ากลับมาเขียนทับ

- ทุก request จับ userId/sessionEpoch/holdingsRevision/endDate และ UI request ID ก่อนเริ่ม
- เมื่อ invalidate ให้เพิ่ม epoch/generation และยกเลิกคำขอเดิมเท่าที่ทำได้ ผลที่กลับมาทีหลังต้องถูกทิ้งทั้งจาก cache และ UI แม้ HTTP สำเร็จ ห้ามตรวจเฉพาะว่า range ตรงกัน
- เปลี่ยนช่วงแล้วผลของช่วงเก่ากลับมาทีหลัง อาจเก็บลง key ของมันได้เฉพาะ context ยังไม่เปลี่ยน แต่ห้ามเอามาทับกราฟช่วงที่ผู้ใช้เลือกใหม่
- รวม inFlight ตาม key; หากหลาย component ใช้คำขอเดียวกัน การออกจาก component หนึ่งไม่ควร abort คำขอของอีก component โดยไม่มี reference counting
- แยก retry/diagnostics ของแต่ละ key ไม่เอาข้อความ HTTP 400/429 เก่าของ ALL ไปติดบน range ใหม่ที่ใช้ cache สำเร็จแล้ว

## Acceptance tests ให้ frontend

1. เปิด 1M แล้ว 1W แล้วกลับ 1M → HTTP สองครั้ง ไม่ใช่สาม และค่า 1M เดิมไม่เปลี่ยน
2. โหลด ALL ครบ แล้วกด 1D/1W/1M/3M/1Y → HTTP เพิ่มศูนย์ครั้ง ทุกจุดตรงกับ slice ของ ALL และได้ช่วงวันรวมต้น-ปลายตามตาราง
3. ALL ไม่ครบหรือหมดอายุ → ไม่ derive เป็น COMPLETE เงียบ ๆ ขอ exact range ตามจริง
4. ตัด ALL ตอนใกล้ expiry แล้วกลับมาอีก → ไม่ต่ออายุ snapshot จากการกดปุ่ม
5. Import บางรายการสำเร็จ / ลบรายการ / manual refresh → ALL และทุก range เก่าถูก invalidate
6. Logout A → login B ระหว่าง request A ยังรัน → ไม่เห็นกราฟ A แม้ response A กลับมาทีหลัง
7. Revision เปลี่ยนขณะ range เดิมกำลังโหลด → response รุ่นเก่าไม่กลับเข้า fresh cache
8. ข้ามเที่ยงคืนไทยขณะเปิดหน้า หรือกลับจาก background → ไม่ใช้ endDate ของวันก่อน
9. สอง consumer ขอ key เดียวกันพร้อมกัน → HTTP ครั้งเดียว; สลับไป cache hit ระหว่างรออีก key ได้ทันที
10. Provider retry/partial outage → ไม่ยิงวน ไม่แทน null ด้วย 0 และถ้าแสดง last-good ต้องระบุว่าเป็นข้อมูลเก่าอย่างชัดเจน

งานนี้ไม่ต้องเพิ่ม SQL หรือ `.env` และไม่เปลี่ยน response Backend; เป็นแผน frontend state/cache สำหรับนำไป implement แยกต่างหาก
