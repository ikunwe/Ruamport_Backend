# Frontend: เรท USD → THB สำหรับแสดงพอร์ต

Backend เพิ่ม Frankfurter v2 เพื่อแปลงยอดหุ้นนอก USD เป็น THB ด้วยเรทชุดเดียวกันในแต่ละ response โดยไม่เปลี่ยนยอดจาก PDF และไม่เปลี่ยนวิธีคำนวณต้นทุน

ไม่ต้องเพิ่ม SQL, ย้ายข้อมูล, sync/import ใหม่ หรือตั้ง API key เพิ่ม

การตรวจ rateDate ใช้วันปฏิทิน Asia/Bangkok (UTC+7) ไม่อิง timezone ของเครื่อง server: วันที่ตรงกับวันนี้ของไทยรับได้แม้ UTC ยังเป็นวันก่อนหน้า วันที่เกินวันนี้ของไทยหรือย้อนหลังตั้งแต่ 7 วันปฏิทินขึ้นไปยังถูกปฏิเสธ ทั้งตอนโหลดใหม่และใช้ cache สำรอง ส่วน TTL 1 ชั่วโมง/อายุ cache สูงสุด 24 ชั่วโมงยังวัดเวลาที่ผ่านไปจริงตามเดิม fetchedAt/expiresAt ยังคงส่ง ISO UTC ลงท้าย Z และ rateDate ยังคงวันที่เดิมจาก provider ไม่ปรับหรือสร้างวันที่ใหม่แทน

## Endpoint ที่แนะนำสำหรับหน้า Port

### Fallback เมื่อ latest ส่งวันที่อนาคต

หากข้อมูลล่าสุดมีวันที่เกินวันนี้ของไทย Backend จะไม่ใช้แถวนั้น แต่เรียก Frankfurter `/v2/rates` เพิ่มหนึ่งครั้ง ระบุ base=USD, quotes=THB และช่วง from=วันนี้ลบ 6 วัน ถึง to=วันนี้ จากนั้นเลือกวันที่ใหม่ที่สุดในช่วงที่ไม่เกินวันนี้ จึงใช้เรทวันนี้ได้หากมี หรือวันประกาศก่อนหน้าล่าสุดหากวันนี้ไม่มีข้อมูล ไม่เดินเรียกทีละวันและไม่แก้วันที่ provider ให้ดูเป็นวันนี้ อ้างอิง [Frankfurter Historical/Time Series API](https://frankfurter.dev/)

ตัวอย่างฟิลด์ที่เพิ่มใน response เรท หรือ holdings.fx:

```json
{
  "status": "AVAILABLE",
  "source": "FRANKFURTER",
  "rate": 33.709,
  "rateDate": "2026-10-24",
  "selectionMode": "HISTORICAL_FALLBACK",
  "fallbackReason": "FUTURE_RATE_DATE",
  "requestedThroughDate": "2026-10-24",
  "fromCache": false,
  "isStale": false
}
```

selectionMode=LATEST หมายถึงใช้ endpoint ล่าสุดตามปกติ ส่วน HISTORICAL_FALLBACK หมายถึงเลือกจากประวัติหลัง latest มีวันที่อนาคต requestedThroughDate คือขอบบนวันไทยที่ใช้ค้นหา **ไม่ใช่วันที่จริงของเรท** ให้ใช้ rateDate แสดงวันที่เสมอ fallbackReason อธิบายเหตุที่ไปใช้ history ไม่ใช่ error เมื่อ status=AVAILABLE Frontend ไม่ต้องเรียกเรทย้อนหลังเอง

history fallback ที่เพิ่งดึงผ่าน validation ยังมี isStale=false แม้ rateDate เป็นวันก่อนหน้า สถานะนี้บอก freshness ของ cache ไม่ได้แปลว่าวันนี้ต้องมีประกาศใหม่ การใช้ cache สำรองเก่าหลัง refresh ล้มเหลวยังคง isStale=true และ warning ตามเดิม โดยคง selectionMode ของเรทที่เก็บไว้

ปกติหนึ่ง refresh ใช้ 1 คำขอ กรณี latest วันที่อนาคตใช้สูงสุด 2 คำขอ (latest+history) มี timeout รวมชุดเดิม 5 วินาที ทั้งคู่แชร์ single-flight/cache 1 ชั่วโมง จึงไม่เพิ่มคำขอทุกครั้งที่ Frontend เรียก ไม่เพิ่ม env/API key/SQL และไม่เปลี่ยนยอด PDF

หาก history ไม่มีข้อมูลที่ผ่านในช่วงอายุไม่ถึง 7 วันไทย และไม่มี cache สำรอง จะตอบ 503 reason=HISTORICAL_RATE_UNAVAILABLE หากประวัติผิดรูปแบบหรือวันที่ล่าสุดในช่วงมีเรทขัดกันจะตอบ INVALID_RESPONSE ไม่เลือกวันเก่ามาปิดบังความขัดแย้ง การเชื่อมต่อ/HTTP/timeout ยังคงรายงาน reason ตามสาเหตุ และ retry backoff 1 นาทีเหมือนเดิม ไม่ fallback history สำหรับ timeout/HTTP error ของ endpoint ล่าสุดที่ไม่ใช่ปัญหาวันที่อนาคต

### รายละเอียดเมื่อ endpoint เรทตอบ 503

`error.code` ยังคง FX_RATE_UNAVAILABLE แต่ message เป็นข้อความที่ปลอดภัยและแยกสาเหตุ มี reason และ retryAt เพิ่ม เช่น:

```json
{
  "error": {
    "code": "FX_RATE_UNAVAILABLE",
    "message": "The provider rate date is later than the current date in Thailand",
    "reason": "FUTURE_RATE_DATE",
    "retryAt": "2026-10-23T18:01:00.000Z"
  }
}
```

reason อาจเป็น TIMEOUT (หมดเวลารอ), NETWORK_ERROR (เชื่อมต่อไม่ได้), UPSTREAM_HTTP_ERROR (HTTP ไม่สำเร็จ), UPSTREAM_RATE_LIMITED (429), INVALID_RESPONSE (JSON/คู่เงิน/เรท/วันที่ผิดรูปแบบ), FUTURE_RATE_DATE (เกินวันนี้ไทย), RATE_TOO_OLD (อายุวันที่เรทตั้งแต่ 7 วันไทย) ให้ใช้ reason/code ใน logic ไม่ parse message ใช้ retryAt ประกอบการลองใหม่ ไม่ยิงวนทันที ระหว่าง backoff จะคงสาเหตุล่าสุด ไม่ส่ง raw upstream body/URL/headers หรือรายละเอียด network ภายใน

เมื่อใช้ cache สำรอง endpoint ยังตอบ 200 ตามเดิม พร้อม warning=FX_REFRESH_FAILED_USING_CACHED_RATE และเพิ่ม reason/retryAt เพื่ออธิบายเหตุ refresh ไม่สำเร็จ ฟิลด์ snapshot อื่นไม่เปลี่ยน กรณี 5xx ของระบบส่วนอื่นยังไม่เปิดเผยข้อความภายใน การแก้ข้อความนี้ไม่ได้ทำให้เรทที่ไม่ผ่าน validation ถูกยอมรับ

```http
GET /api/v1/trades/holdings?includeFx=true
Authorization: Bearer <Supabase access token>
```

ใช้ร่วมกับ `includeClosed=true` ได้ หากไม่ส่ง `includeFx` หรือส่ง `includeFx=false` จะได้ response เดิมโดยไม่เรียก Frankfurter ค่าของสอง query นี้ต้องเป็น `true` หรือ `false` เท่านั้น ไม่รองรับ query เพื่อเปลี่ยนสกุลเงิน/ผู้ให้บริการ/URL

ข้อมูลเดิมทั้งหมดอยู่เหมือนเดิม เพิ่ม `fx`, `items[].displayThb` และ `displayThb` ระดับบน

ตัวอย่างย่อ (เรทและตัวเลขเพื่ออธิบาย contract ไม่ใช่การรับรองเรทล่าสุด):

```json
{
  "fx": {
    "status": "AVAILABLE",
    "source": "FRANKFURTER",
    "apiVersion": "v2",
    "providerMode": "BLENDED",
    "baseCurrency": "USD",
    "quoteCurrency": "THB",
    "rate": 33.498,
    "rateDate": "2026-10-19",
    "fetchedAt": "2026-10-20T08:00:00.000Z",
    "expiresAt": "2026-10-20T09:00:00.000Z",
    "fromCache": true,
    "isStale": false
  },
  "items": [
    {
      "assetType": "OFFSHORE_STOCK",
      "currency": "USD",
      "symbol": "EXAMPLE",
      "amounts": [
        { "currency": "USD", "totalBuyGross": 29.95, "totalFeeIncludeVat": 0.05 },
        { "currency": "THB", "totalBuyGross": 1048.25, "totalFeeIncludeVat": 1.75 }
      ],
      "costBasis": [
        { "currency": "USD", "remainingCost": 20, "averageCostPerUnit": 10 },
        { "currency": "THB", "remainingCost": 700, "averageCostPerUnit": 350 }
      ],
      "displayThb": {
        "currency": "THB",
        "sourceCurrency": "USD",
        "amounts": {
          "currency": "THB",
          "sourceCurrency": "USD",
          "totalBuyGross": 1003.27,
          "totalFeeIncludeVat": 1.67
        },
        "costBasis": {
          "currency": "THB",
          "sourceCurrency": "USD",
          "remainingCost": 669.96,
          "averageCostPerUnit": 334.98
        }
      }
    }
  ],
  "displayThb": {
    "currency": "THB",
    "sourceCurrency": "USD",
    "scope": "ALL_IMPORTED_USD_STOCK_POSITIONS_INCLUDING_CLOSED",
    "moneyTotals": {
      "currency": "THB",
      "sourceCurrency": "USD",
      "totalBuyGross": 1003.27
    },
    "remainingCostTotal": {
      "currency": "THB",
      "sourceCurrency": "USD",
      "remainingCost": 669.96
    }
  }
}
```

ใน response จริงจะมี method/status/จำนวนรายการ/completeness/metadata เดิมตามข้อมูลต้นทางด้วย ตัวอย่างข้างบนละไว้เพื่อให้อ่านง่าย

## Frontend ควรใช้ค่าไหน

| สิ่งที่แสดง | Field |
|---|---|
| เรท และวันที่เรท | `fx.rate`, `fx.rateDate` |
| USD รายหุ้น | `items[].amounts` / `items[].costBasis` แถว `currency=USD` ตามเดิม |
| ยอดซื้อขาย/ค่าธรรมเนียมแปลงบาทรายหุ้น | `items[].displayThb.amounts` |
| ต้นทุนคงเหลือ/เฉลี่ยแปลงบาทรายหุ้น | `items[].displayThb.costBasis.remainingCost` / `.averageCostPerUnit` |
| ยอดซื้อขาย/ค่าธรรมเนียม USD stocks รวมที่แปลงบาท | `displayThb.moneyTotals` |
| ต้นทุนคงเหลือ USD stocks รวมที่แปลงบาท | `displayThb.remainingCostTotal.remainingCost` |
| THB ย้อนหลังตาม PDF | แถว `currency=THB` ใน `amounts` / `costBasis` เดิม |

`items[].displayThb` มีเฉพาะ `OFFSHORE_STOCK` ที่สกุลหลัก `USD` เท่านั้น หุ้นไทย/กองทุน/หุ้นนอกสกุลอื่นได้ `null` และยังใช้ยอดเดิม ไม่แปลงซ้ำ

ยอดรวมใหม่แปลงจากแถว USD ของ `stockMoneyTotals` และ `stockRemainingCostTotals` เดิม จึงรวมตำแหน่งที่ขายหมดแล้วตาม scope เดิมด้วย ไม่ใช่ผลบวกเฉพาะ card ที่มองเห็น และไม่รวมยอดหุ้นไทย/กองทุน THB ห้ามนำยอดนี้บวกกับ `moneyTotals` THB เดิมซึ่งมี THB ย้อนหลังหุ้นนอกอยู่แล้ว เพราะจะซ้ำ

ทุกยอดแปลงใน response เดียวกันใช้ `fx.rate` เดียวกันเสมอ ถ้าต้องการรวมยอดหน้า Port ให้ใช้ snapshot จาก response นี้ ไม่ผสมกับเรทจากอีก request เพราะ cache อาจ refresh ระหว่าง request ได้

### ยอดที่แปลง

`displayThb.amounts` และ `displayThb.moneyTotals` คงชื่อ field ของ USD ต้นทางไว้ แต่แปลง monetary fields ต่อไปนี้เป็น THB:

- `totalBuy`, `totalSell`, `totalSwitchIn`, `totalSwitchOut`, `netBuySellCashFlow`
- `totalBuyGross`, `totalSellGross`, `totalSwitchInGross`, `totalSwitchOutGross`
- `totalBuyFeeIncludeVat`, `totalSellFeeIncludeVat`, `totalSwitchInFeeIncludeVat`, `totalSwitchOutFeeIncludeVat`, `totalFeeIncludeVat`

จำนวนรายการและ flags เช่น `isComplete`, `grossIsComplete`, `feeIsComplete`, `missingAmountCount` ไม่ถูกคูณเรท

`displayThb.costBasis` แปลง `remainingCost`, `rawRemainingCost`, `averageCostPerUnit`, `rawAverageCostPerUnit` ส่วนจำนวนหุ้น/method/status/issues/source/feesIncluded คงเดิม `source` ใน costBasis ยังหมายถึงที่มาของต้นทุน USD; แหล่งเรทดูที่ `fx.source` ไม่ใช่ PDF

ยอดเงินปัดทศนิยม 2 ตำแหน่ง ต้นทุนเฉลี่ยต่อหน่วยปัด 8 ตำแหน่ง ใช้ decimal multiplication และ half-away-from-zero จากตัวเลข USD ที่ Backend ได้รับ ไม่ปัดแก้ต้นทุนต้นทาง ยอดรวมแปลงจากยอดรวม USD ก่อนปัด จึงอาจต่างจากการบวกยอดรายหุ้นที่ปัดแล้วเล็กน้อย

`null` ยังคงเป็น `null` ไม่แทนด้วย 0; ถ้าไม่มีแถว USD ต้นทางจะได้ object ส่วนนั้นเป็น `null` ยอดที่เกินขอบเขตจำนวนเต็มปลอดภัยของ JavaScript หลัง scale เพื่อปัดจะได้ `null` เช่นกัน ห้ามใช้ `?? 0` แล้วอ้างว่าเป็นต้นทุนที่ยืนยันแล้ว หากต้นทางบอก incomplete ต้องแสดงว่าไม่ครบแม้ยอดรวมบางส่วนจะเป็นตัวเลข

## Endpoint เฉพาะเรท

```http
GET /api/v1/trades/exchange-rate
Authorization: Bearer <Supabase access token>
```

ได้ object รูปแบบเดียวกับ `fx` เมื่อพร้อมใช้งาน ใช้ cache เดียวกับ holdings เหมาะกับ widget แสดงเรทอย่างเดียว ส่วนหน้า Port ที่ต้องการยอดแปลงควรใช้ holdings request เดียว

## Cache และกรณีผิดพลาด

- Cache ใน memory ต่อ Backend process ใช้ร่วมกันทุกผู้ใช้ เพราะเป็นเรทสาธารณะ ไม่มีข้อมูลพอร์ตใน cache เรท
- TTL 1 ชั่วโมง Refresh เมื่อมี request หลังหมดอายุ ไม่ได้ตั้ง background job คำขอพร้อมกันรอ upstream call เดียว
- Upstream timeout 5 วินาที เมื่อ refresh ล้มเหลว พักการ retry 60 วินาที
- ถ้ามี cache ที่ดึงมาไม่ถึง 24 ชั่วโมง และวันที่เรทอายุไม่ถึง 7 วัน จะยังใช้ได้เมื่อ upstream ล่ม โดย `isStale=true`, `fromCache=true`, `warning="FX_REFRESH_FAILED_USING_CACHED_RATE"` วันที่เรทและ fetchedAt ไม่ถูกเปลี่ยนให้ดูเหมือนข้อมูลใหม่
- เมื่อไม่มี cache ที่ใช้ได้ `/exchange-rate` ตอบ HTTP 503 พร้อม `error.code=FX_RATE_UNAVAILABLE`
- แต่ `/holdings?includeFx=true` ยังตอบ HTTP 200 พร้อมข้อมูลพอร์ตเดิม, `fx.status=UNAVAILABLE`, `fx.rate=null`, `fx.rateDate=null`, `fx.errorCode=FX_RATE_UNAVAILABLE`, `displayThb=null` และ `items[].displayThb=null` UI แสดง USD ต่อไป และใช้ข้อความว่า “ยังไม่สามารถแปลงเป็นบาทได้” ห้ามเดาเรทหรือสลับไปใช้ THB ย้อนหลังเงียบ ๆ
- Response HTTP ใช้ `Cache-Control: no-store` เพื่อไม่เก็บข้อมูลพอร์ตใน browser/proxy; ไม่ใช่การปิด cache เรทภายใน Backend
- Restart ทำให้ cache หาย หลาย instance มี cache แยกกัน จึงอาจ refresh ต่างเวลากัน ต้องใช้เรท snapshot ของ response นั้น ถ้าต้องการทั้ง cluster ใช้ cache เดียวกันภายหลังค่อยเพิ่ม Redis/DB

`isStale=false` หมายถึง cache ยัง fresh ไม่ได้แปลว่าวันที่เรทต้องตรงกับวันนี้ วันหยุดอาจได้วันที่ย้อนหลัง ให้แสดง `rateDate` เสมอ ไม่ใช้ `fetchedAt` แทน

## ขอบเขตที่ไม่เปลี่ยน

- เก็บ USD/THB เดิมจาก PDF และวิธีต้นทุนหุ้นนอก Compressed FIFO, หุ้นไทย FIFO, กองทุน Average Cost ตามเดิม
- ไม่มีการอัปเดตตารางหรือ PDF preview ด้วยเรทใหม่ และไม่หักค่าธรรมเนียมหรือส่วนลดเพิ่ม
- `remainingCost` ที่แปลงด้วยเรทล่าสุดยังเป็น **ต้นทุนคงเหลือแปลงสกุลเงิน** ไม่ใช่มูลค่าตลาดปัจจุบัน เพราะยังไม่ได้ดึงราคาหุ้น/NAV
- ยังไม่คำนวณกำไร/ขาดทุนค่าเงิน หรือกำไร/ขาดทุนหุ้น สามารถใช้ยอด THB ต้นทุนย้อนหลังเทียบในงานภายหลังได้
- Frankfurter v2 ที่ใช้เป็น daily reference / mid-market แบบ blended providers ไม่ใช่เรทแลกของ Dime/ธนาคารหรือ bid/ask ที่ซื้อขายได้จริง และไม่ใช่ราคา realtime ดู [เอกสาร Frankfurter](https://frankfurter.dev/)
- Backend ส่งเพียงคำขอคู่ USD/THB สาธารณะไป upstream ไม่ส่ง token, อีเมล, รายการซื้อขาย หรือข้อมูล PDF

ไม่มี environment variable ใหม่ที่จำเป็น ไม่มี API key หรือ migration ใหม่ เปิด HTTPS outbound ไป `api.frankfurter.dev` ได้ก็ใช้งานได้

สคริปต์ `npm run dev` / `npm start` ใช้ Node `--use-system-ca` เพื่อเชื่อถือ certificate store ของ OS ร่วมกับ CA ของ Node (จำเป็นกับ HTTPS chain ในเครื่องพัฒนานี้) ยังคงตรวจสอบ certificate ตามปกติ ไม่ใช้ `NODE_TLS_REJECT_UNAUTHORIZED=0` หากรัน Node โดยตรงให้ใส่ flag เดียวกัน และใช้ Node 24 ขึ้นไปตามข้อกำหนดโปรเจค
