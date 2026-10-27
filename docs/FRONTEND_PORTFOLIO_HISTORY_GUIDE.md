# กราฟมูลค่าสินทรัพย์ย้อนหลัง (รายวัน)

## สถานะสำคัญ

กราฟรายวันใช้ **Yahoo Finance เฉพาะราคาย้อนหลังหุ้นนอกและหุ้นไทย**, SEC สำหรับ NAV กองทุน และ Frankfurter สำหรับเรทย้อนหลัง ราคาล่าสุด/โลโก้/ข่าวหุ้นนอกยังใช้ Finnhub เหมือนเดิม ไม่เรียก Finnhub /stock/candle ใน flow กราฟแล้ว เพราะ key ที่ทดสอบถูกปฏิเสธ HTTP 403 หากประวัติจาก provider ใดไม่พร้อม กราฟรวมจะ INCOMPLETE/marketValue=null ไม่สร้างราคาย้อนหลังจากราคาปัจจุบันแทน

ทดสอบด้วยพอร์ตจำลองที่มี NVDA 2 หุ้น, ASK 5 หุ้น และ KKP US500-UH-E 10 หน่วย โดยดึงข้อมูลย้อนหลังจริง ได้กราฟ 15 จุดครบทุกวันในช่วงทดสอบและเรียกซ้ำใช้ cache การทดสอบนี้ไม่ได้อ่านหรือแก้พอร์ตจริงใน Supabase ไม่รับประกัน coverage ของทุก symbol/ทุกช่วงเวลา

### Provider และการตรวจตัวตนหุ้นนอก

หุ้นนอก Yahoo ใช้ ticker จดทะเบียนสหรัฐเดิม เช่น ASML/TSM ไม่เปลี่ยนเป็น ASML.AS/2330.TW ซึ่งเป็น ticker บริษัทต้นทางสำหรับกรณีโลโก้ ตรวจ symbol ตรง, currency=USD, instrumentType เป็น EQUITY/ETF และ exchange ตรง MIC จาก PDF (เช่น XNAS → NMS/NGM/NCM, XNYS → NYQ) ถ้าตลาดไม่ตรงจึงใช้ Finnhub catalog ยืนยันตลาดปัจจุบันตามเงื่อนไขด้านล่าง ไม่ยอมใช้ข้อมูลคนละตลาดเพียงเพราะชื่อบริษัทคล้ายกัน และไม่ส่ง Finnhub/SEC key ไป Yahoo

ตัวเลขใน points และชื่อ field เดิมไม่เปลี่ยน positions[].source ของหุ้นนอกย้อนหลังเป็น YAHOO_FINANCE ส่วน items[].marketValuation.quote.source ใน endpoint holdings ล่าสุดยังเป็น FINNHUB ข้อมูลคนละแหล่ง/เวลาปิดจึงอาจต่างกันได้ ไม่บังคับจุดสุดท้ายของกราฟให้เท่ากับราคาล่าสุดด้วยการเขียนทับ

## เปิดใช้

### Split และตลาดไม่ตรง: อัตโนมัติเฉพาะกราฟย้อนหลัง

ไม่ใช้รายชื่อข้อยกเว้น NFLX/QS ในโค้ดแล้ว รองรับหุ้นนอกและหุ้นไทยที่ Yahoo ส่ง split events ให้ โดยอ่านวัน numerator/denominator และตรวจรูปแบบก่อนใช้ รองรับ forward split, reverse split และหลายเหตุการณ์ตามลำดับวัน ไม่มีการแก้ orders/PDF/ต้นทุน holdings หรือ endpoint ราคาล่าสุด

- ขอประวัติราคาและเหตุการณ์ตั้งแต่ก่อนการซื้อครั้งแรกของแต่ละกลุ่ม ไม่ใช่แค่ช่วงที่เลือก เพื่อให้จำนวนหุ้นยกมารวมผล split ที่เกิดก่อนช่วงกราฟ
- คืนราคาปิด Yahoo จากฐานปรับ split ให้เป็นราคาตามฐานหุ้นในวันนั้น ด้วยผลคูณ ratio ของทุก split ที่เกิดภายหลังวันราคา ก่อนปัดเศษ
- Replay จำนวนหุ้นที่ถือค้างตาม ratio ในวัน split ก่อนรายการซื้อขายของวันเดียวกัน ไม่คูณหุ้นที่ซื้อหลัง split ซ้ำ ขายหมดก่อน split ยังคงเป็นศูนย์ รวมถึงเศษที่ปิดตาม tolerance เดิม
- ใช้ BigInt decimal และเก็บฐานหลังหารถึง 18 ตำแหน่ง รองรับ reverse split ที่มีหน่วยเศษ แต่ไม่เดาว่าโบรกเกอร์จ่าย cash-in-lieu/ปัดหน่วยอย่างไร หากเศษเล็กจนสูญเสีย precision จะส่ง issue ไม่ปิดเป็นศูนย์เงียบ ๆ
- Event ต้องมีวันที่ในช่วงที่ขอ ไม่ซ้ำวัน อัตราเป็นจำนวนเต็มบวกแต่ละฝั่งไม่เกิน 1,000,000 และไม่เท่ากับ 1:1 สูงสุด 100 เหตุการณ์ หาก splitRatio ที่ provider ส่งมาขัดกับ numerator/denominator จะไม่ใช้ข้อมูลชุดนั้น
- กรณี event ผิดรูปแบบส่ง HISTORY_CORPORATE_ACTION_INVALID กรณี event coverage ยาวเกินขอบเขตส่ง HISTORY_EVENT_RANGE_TOO_LARGE ไม่แก้ด้วยราคาปัจจุบันหรือเดา action ที่ไม่ปรากฏใน provider
- ไม่ใช่ระบบยืนยันความครบถ้วนของ corporate actions ทุกประเภท ยังไม่รองรับ spinoff, merger, ticker reuse/rename, cash distributions หรือการโอนหุ้นอัตโนมัติ และไม่รับประกันว่า provider จะส่ง event ครบทุก symbol

กรณีตลาดใน PDF ไม่ตรง Yahoo สำหรับหุ้นนอกสหรัฐ:

1. ticker ต้องตรง สกุล USD และประเภท EQUITY/ETF ต้องผ่านก่อน
2. ถ้าตลาดไม่ตรง จึงขอให้ Finnhub catalog ยืนยัน listing ปัจจุบันของ ticker เดียวกัน ต้องมีตลาดสหรัฐกลุ่มเดียวที่ไม่กำกวม พร้อม security type ที่ตรง Yahoo
3. หากยืนยันได้ ใช้ราคา Yahoo สำหรับกราฟเท่านั้น เก็บตลาดจาก PDF เดิมและส่ง metadata ว่าใช้ตลาดปัจจุบันที่สองแหล่งยืนยันตรงกัน
4. ถ้าไม่มีสิทธิ์/ไม่มี key/timeout/หลายตลาดกำกวม/ประเภทไม่ตรง จะส่ง HISTORY_LISTING_UNVERIFIED และเว้นกราฟ ไม่ปล่อยทุกตลาดผ่าน

การยืนยันนี้ไม่ใช่หลักฐานว่า PDF ผิด หรือยืนยันประวัติการย้ายตลาดและวันที่ย้ายจริง ไม่อนุมาน effectiveDate จากการซื้อครั้งแรก จึงส่ง effectiveDate=null การย้าย/ชื่อบริษัท/ticker reuse ที่ต้องใช้ historical instrument identity ยังต้องตรวจแยกก่อนใช้เป็นข้อมูลบัญชี ไม่รองรับการข้ามประเทศ/สกุลเงินโดยอัตโนมัติ ตลาดหุ้นไทยยังต้องตรง SET/BKK ตาม validation เดิม

หากรายการซื้อกับขายของหุ้นเดียวกันอยู่คนละตลาดใน PDF กราฟจะรวมลำดับรายการข้ามตลาดเฉพาะเมื่อ account/ticker/currency ตรงกัน มีผลยืนยันตลาดปัจจุบันจากสองแหล่ง มีประเภท/ตลาด canonical เดียวกัน และ split timelines สอดคล้องกัน เพื่อไม่ให้กลุ่มซื้อเก่าค้างอยู่พร้อมกลุ่มขายใหม่ติดลบ เพิ่ม positions[].pdfExchanges แสดงตลาดต้นฉบับทั้งหมดที่รวม ไม่รวมข้ามบัญชี และไม่แก้ exchange ที่เก็บใน Database หากยืนยันไม่ครบยังแยกกลุ่มและแสดง gap ตามเดิม

positions[] ยังมี corporateActions[], priceBasis และ listingTransfer เพื่อความเข้ากันได้ ตัวอย่าง:
```json
{
  "symbol": "NFLX",
  "priceBasis": "AS_TRADED_UNADJUSTED",
  "corporateActions": [
    {"type":"SPLIT","date":"2025-11-17","numerator":10,"denominator":1,"source":"YAHOO_FINANCE"}
  ],
  "listingTransfer": null
}
```

เมื่อยืนยันตลาดใหม่ได้ listingTransfer มี type=CORROBORATED_CURRENT_LISTING, fromMic/toMic, effectiveDate=null, source=FINNHUB_LISTING_CATALOG_AND_YAHOO, verifiedAt, providerExchange และ pdfMarketPreserved=true ฟิลด์ชื่อ listingTransfer เป็นชื่อเดิมแต่ **ไม่ใช่การยืนยันวันย้ายตลาด** Frontend ไม่ควรแสดงว่า “ย้ายวันที่ …” จากค่าที่ไม่ทราบ

Frontend ใช้ points[].marketValue ตามเดิม ไม่คูณราคา/จำนวนหุ้นจาก metadata ซ้ำ metadata ใช้แสดงคำอธิบายได้ ไม่มี action ส่ง [] ไม่มี market override ส่ง null

ทดสอบข้อมูลจริง NFLX/QS ด้วย `node --use-system-ca --env-file=.env scripts/verification/verify-history-corporate-actions.cjs` ใช้จำนวนจำลอง ช่วง 16 มิ.ย. 2025–24 ต.ค. 2026 ได้ 496 จุดครบ ไม่มี gap ในหน้าต่างเดิม 67 วัน ไม่ใช่การประเมินพอร์ตจริง ไม่อ่าน/เขียน Supabase ทดสอบเพิ่มเติมด้วยประวัติจริง NVDA (forward 10:1), SQQQ (reverse 1:5 สองครั้ง) และ PLTR (PDF-market input XNYS แต่ตลาดปัจจุบันยืนยันเป็น Nasdaq) ได้ข้อมูลโดยไม่เพิ่มชื่อในโค้ด

รัน migration 020_portfolio_history_orders.sql หลัง 019 ใน Supabase SQL Editor ไม่ต้องลบ table หรือ reimport เพิ่ม read-only RPC คืนรายการของผู้ใช้ที่ import แล้ว พร้อมกรอง duplicate และตรวจ collision ไม่เพิ่ม table/column หรือบันทึก snapshot ใหม่ สิทธิ์ RPC เฉพาะ service_role ไม่มีการรัน migration กับ Supabase จริงอัตโนมัติ

```http
GET /api/v1/trades/portfolio-history?range=1M
Authorization: Bearer <Supabase access token>
```

range: 1D, 1W, 1M, 3M, 1Y, ALL ค่าเริ่มต้น 1M เป็นช่วงย้อนหลัง 1/7/30/90/365 วันปฏิทิน รวมวันต้นและปลาย ไม่ใช่เดือนปฏิทิน ตัดวันเริ่มให้ไม่ก่อนรายการแรก ALL เริ่มวันคำสั่งมีผลแรก ปลายคือวันนี้ไทย

**ทุก range เป็น granularity=DAY รวมถึง 1D** ซึ่งเป็นวันนี้และวันก่อนหน้า (ถ้ามีประวัติถึง) ไม่ใช่กราฟ intraday ทุก 15 นาที ไม่ได้เพิ่มระบบเก็บ snapshot ระหว่างวัน ไม่รับ userId/symbol/URL จาก query ไปเลือกข้อมูลเจ้าของอื่นหรือเรียก upstream ตามอำเภอใจ

## วิธีคำนวณ

อ่านรายการทั้งหมดตั้งแต่เริ่มเพื่อหายอดยกมา แม้เลือก 1W ก็ไม่เริ่มจำนวนหุ้นจากศูนย์เมื่อสัปดาห์ก่อน ใช้ effective trade_date ไม่ใช่ settlement date หรือวันที่ upload คิดจำนวนสิ้นวันตามวันใน PDF ไม่มี execution time ให้ยืนยันลำดับระหว่างวัน

- หุ้น: BUY เพิ่ม SELL ลด; รายการพิเศษที่ยังไม่รองรับทำให้ช่วงหลังรายการนั้นไม่ครบ
- กองทุน: SUBSCRIPTION/SWITCH_IN เพิ่ม REDEMPTION/SWITCH_OUT ลดหน่วย ไม่เกี่ยวกับวิธีต้นทุน
- แยกบัญชี/สินทรัพย์/symbol/ตลาด/สกุลเงินเหมือน holdings หุ้นที่ขายหมดในปัจจุบันยังอยู่ในกราฟช่วงที่เคยถือ ต้องตรวจ split ของประวัติก่อนช่วงที่เลือกด้วย เพราะยอดซื้อ/ขายดิบเท่ากันอาจยังไม่ใช่ยอดปิดหลัง split จึงอาจมีคำขอให้ตัวที่ดูเหมือนขายหมดก่อนช่วงนั้น
- หุ้นใช้เกณฑ์ปิดเศษเดิม ±0.0000003 เมื่อมีทั้งซื้อ/ขายและไม่มี issue ไม่แก้จำนวนดิบ ไม่ใช้เกณฑ์นี้กับกองทุน

```text
หุ้นนอก ณ วัน D = จำนวนที่ถือสิ้นวัน D × ราคาปิด USD ที่มี ณ D × เรท USD/THB ที่มี ณ D
หุ้นไทย ณ วัน D = จำนวนที่ถือสิ้นวัน D × ราคาปิด THB ที่มี ณ D
กองทุน ณ วัน D = จำนวนหน่วยสิ้นวัน D × NAV ที่มี ณ D
มูลค่ารวม = ผลรวมสินทรัพย์ทั้งสามประเภทที่ยังถือในวัน D
```

ใช้ราคาย้อนหลัง ไม่ใช้ต้นทุนหรือบวกสะสม daily-change ที่ใช้จำนวนหุ้นปัจจุบัน กราฟมูลค่านี้ **รวมผลค่าเงินย้อนหลัง** ต่างจาก latestChange ที่แปลงทั้งสองฝั่งด้วยเรทเดียวกัน ไม่ใช่กราฟกำไร ไม่รวม Realized PnL ไม่ติดตามเงินสดขายคืน/เงินฝาก และไม่บวกยอดซื้อซ้ำ ราคาขึ้นก็ทำให้มูลค่ากราฟขึ้นได้แม้ไม่ซื้อขาย

ไม่ดึงข้อมูลอนาคตมาย้อนเติม ไม่มี NAV/ราคา/เรทก่อนเริ่มถือให้ใช้ จะเป็นจุดขาด เมื่อวันหยุดใช้ observation ล่าสุดที่ date <= วันกราฟเท่านั้น: หุ้นและ FX อายุไม่ถึง 7 วันปฏิทิน กองทุน NAV อายุไม่ถึง 14 วัน มี lookback 14 วันก่อนช่วงกราฟเพื่อหาค่ายกมา หากเกินเพดานถือว่าขาด ไม่พยายามเดาราคาที่ไม่ประกาศ

daily date หุ้นนอกใช้ New York หุ้นไทย Bangkok และ NAV/FX ใช้วันที่ provider การรวมนี้เป็น daily effective-date approximation ไม่ใช่การยืนยันว่าราคา/เรท/NAV ทั้งหมดเป็นข้อมูลที่รู้แล้ว ณ timestamp เดียวกันของวันนั้น NAV อาจประกาศย้อนหลัง และข้อมูลรายวันอาจได้รับการแก้ไขในภายหลัง จุดล่าสุดอาจยัง provisional และอาจไม่ตรงกับราคาล่าสุดใน holdings

## Response

```json
{
  "range": "1W",
  "granularity": "DAY",
  "currency": "THB",
  "valuationBasis": "DAILY_OBSERVATIONS_WITH_BOUNDED_CARRY_FORWARD",
  "status": "COMPLETE",
  "startDate": "2026-10-17",
  "endDate": "2026-10-24",
  "firstTradeDate": "2026-08-01",
  "calculatedAt": "2026-10-24T08:00:00.000Z",
  "missingPointCount": 0,
  "points": [
    {
      "date": "2026-10-17", "currency": "THB",
      "marketValue": 2100, "availableMarketValue": 2100, "isComplete": true,
      "heldPositionCount": 2, "valuedPositionCount": 2, "missingPositionCount": 0,
      "carriedPositionCount": 1,
      "oldestPriceDate": "2026-10-16", "newestPriceDate": "2026-10-17",
      "fxRateDate": "2026-10-16",
      "byAssetType": [
        {"assetType":"OFFSHORE_STOCK","currency":"THB","marketValue":1700,"availableMarketValue":1700,"heldPositionCount":1,"valuedPositionCount":1,"isComplete":true},
        {"assetType":"THAI_STOCK","currency":"THB","marketValue":400,"availableMarketValue":400,"heldPositionCount":1,"valuedPositionCount":1,"isComplete":true},
        {"assetType":"MUTUAL_FUND","currency":"THB","marketValue":0,"availableMarketValue":0,"heldPositionCount":0,"valuedPositionCount":0,"isComplete":true}
      ],
      "issues": []
    }
  ],
  "positions": [],
  "excludedFutureOrderCount": 0,
  "limitations": []
}
```

ตัวอย่างย่อ points จริงมีทุกวันในช่วง positions จริงมี symbol/ประเภท/บัญชี/ตลาด/currency/source/errorCode ของกลุ่มที่เกี่ยวข้อง ใช้ตรวจ coverage หรือแสดงสาเหตุ provider เช่น HISTORY_ACCESS_DENIED ไม่ใช่รายการซื้อขายทั้งหมด

status=COMPLETE เมื่อทุกจุดคำนวณครบ, INCOMPLETE เมื่อมีจุดขาด, EMPTY เมื่อไม่มีรายการที่มีผลแล้ว points=[] กรณีขายหมดแล้ว marketValue อาจเป็น 0 จริง ต้องแยกจาก null ซึ่งหมายถึงข้อมูลไม่ครบ

Frontend ใช้ points[].date เป็นแกน X และ marketValue เป็นแกน Y ไม่ใช้ availableMarketValue แทนอย่างเงียบ ๆ ให้เว้นเส้นตรงจุด null และไม่ interpolate ข้ามช่องว่างแบบแสดงว่าเป็นยอดจริง หากเลือกแสดง availableMarketValue ต้องติดป้าย “ข้อมูลบางส่วน” byAssetType เป็นโครงสร้างแยกสามประเภท เลือกตามชื่อ assetType ไม่ยึด index

จำนวนถือ/คำนวณนับกลุ่มบัญชี/ตลาด ไม่ใช่ unique ticker ข้อมูลผิดลำดับจนจำนวนติดลบ, collision หรือรายการพิเศษจะระบุ issue และไม่ซ่อนโดยถือว่าเป็นศูนย์ มีช่วงที่ไม่ครบไม่ได้ทำให้ช่วงก่อนหน้าที่ตรวจได้หายไป

## ขอบเขตและภาระ

- อ่านได้สูงสุด 20000 orders, 30 historical instruments, ช่วงสูงสุด 3650 วัน ต้องมี effective trade date ครบ ค่า limit เกินส่ง 422 ไม่ตัดประวัติเงียบ ๆ range ผิดส่ง 400
- ไม่มี SQL cache สำหรับยอดพอร์ต คำนวณยอดส่วนตัวต่อ request ข้อมูลราคา/NAV/FX สาธารณะ cache ใน RAM 6 ชั่วโมง จำกัดขนาด cache และ single-flight ไม่ cache ยอดพอร์ตข้าม user ไม่มี background scheduler
- ขอประวัติให้กลุ่มสินทรัพย์ที่มีรายการ import เพื่อยืนยัน split coverage ก่อน replay ยอดยกมา รวมตัวที่ดูเหมือนปิดก่อนช่วงที่เลือก หากอ่าน action ไม่ได้จะไม่เดาว่าจำนวนดิบที่เป็นศูนย์คือปิดจริง อาจเพิ่ม gap พร้อม HISTORY_QUANTITY_BASIS_UNVERIFIED เกณฑ์สูงสุด 30 instruments จึงนับกลุ่มประวัติด้วย SEC ใช้ annual chunks/pagination เดิม Yahoo มี limiter/cache แยก ไม่ใช้ Finnhub candle แต่การยืนยันตลาดที่ไม่ตรงอาจใช้ Finnhub catalog ภายใต้ budget/cache เดิมของ Finnhub จึงมีภาระเพิ่มครั้งแรกและอาจรอ catalog cold-start
- การโหลดครั้งแรกอาจช้า/ติด quota ได้เมื่อมีหลายสินทรัพย์หรือช่วงยาว ไม่ได้ preload ทุก range หรือเก็บเส้นกราฟถาวร แต่ข้อมูลสาธารณะใช้ range-aware cache ตามสินทรัพย์/แหล่งข้อมูล ไม่แยกชุดตามชื่อช่วงกราฟแล้ว
- Yahoo เป็น unofficial endpoint อาจถูก 429/เปลี่ยนรูปแบบ ไม่รับประกันทุก symbol ก่อน public/commercial deployment ต้องตรวจสิทธิ์ข้อมูลของแต่ละ provider
- รองรับ split/reverse split อัตโนมัติจาก events ที่ผ่าน validation แต่ยังไม่ reconcile merger/spinoff/โอนหุ้น/rename symbol/cash-in-lieu อัตโนมัติ ไม่ควรใช้เป็นรายงานบัญชีหรือภาษีเพียงแหล่งเดียว

การทดสอบใช้ synthetic portfolio กับ provider mocks และ SQL fixtures แยกใน memory ไม่อ่านข้อมูลพอร์ตจริงจาก Supabase หรือ apply migration จริง

ตรวจ provider จริงและการรวมสามสินทรัพย์ได้ด้วย `node --use-system-ca --env-file=.env scripts/verification/verify-portfolio-history.cjs` สคริปต์ใช้พอร์ตจำลองกับราคา/NAV/FX จริง ตรวจ coverage และผลรวมสามประเภท จากนั้นตรวจการเรียกซ้ำผ่าน cache ค่าที่พิมพ์เป็นข้อมูลทดสอบ ไม่ใช่มูลค่าพอร์ตของผู้ใช้ ไม่ควรรันถี่เพราะใช้ quota จริงของ provider

## Cache ข้ามช่วงกราฟ (ALL → 1D / 1W / 1M)

- Endpoint และ response สำหรับ frontend เหมือนเดิม เรียก range ที่ผู้ใช้เลือกได้ตามปกติ ไม่ต้องเรียก ALL ก่อนเสมอ และไม่ต้องคำนวณจำนวนถือหรือ split เอง
- เมื่อ ALL โหลดครบและ cache ยังไม่หมดอายุ คำขอ 1D/1W/1M/3M/1Y ที่อยู่ในช่วงข้อมูลเดิมจะใช้ราคาหุ้นนอก หุ้นไทย NAV และ FX ที่มีอยู่ ไม่ขอ provider ซ้ำ ทั้งนี้ต้องมี lookback และ split-event coverage ครบด้วย
- Backend จำช่วงวันที่ที่ query สำเร็จ รวมวันหยุดที่ไม่มี observation ไม่ตีความว่าไม่มีแถววันหยุด = ต้องดึงซ้ำ
- ถ้าเคยโหลด 1M แล้วเปลี่ยนเป็น ALL จะขอเพิ่มเฉพาะช่วงก่อนหน้าที่ยังไม่มี ถ้าวันสิ้นสุดเลื่อนไปวันใหม่ จะขอเพิ่มเฉพาะวันที่ท้ายที่ขาด ไม่โหลดประวัติทั้งหมดใหม่
- คำขอพร้อมกันของสินทรัพย์เดียวกันใช้คิวร่วมกัน แล้วตรวจ coverage อีกครั้งก่อนขอข้อมูล ลดการขอช่วงทับซ้อน
- RAM cache เก็บ raw close ของ Yahoo พร้อม precision/วันที่ฐานการปรับและ split events แล้วรวมข้อมูลทุกช่วงก่อนแปลงเป็น as-traded ที่ขอบ API ไม่เก็บราคาที่ปัดเศษแยกแต่ละช่วงจนเสียฐาน split การนำ cache มาใช้ยัง replay รายการตั้งแต่ก่อนช่วงกราฟเพื่อคำนวณยอดยกมาอย่างถูกต้อง
- ไม่ cache เส้นกราฟส่วนตัว: แต่ละ request ยังอ่านรายการ import ของผู้ใช้และคำนวณใหม่ หากเพิ่ม/ลบรายการ ยอดกราฟเปลี่ยนได้ทันทีโดยใช้ราคาสาธารณะเดิม ไม่เอายอดของผู้ใช้หนึ่งไปใช้กับอีกคน
- อายุข้อมูลแต่ละช่วงยังเป็น 6 ชั่วโมง (รวมวันที่อาจยัง provisional) ไม่ใช่เก็บถาวร เมื่อหมดอายุจะขอช่วงที่จำเป็นใหม่เพื่อรับการแก้ไขข้อมูลจาก provider เก็บใน RAM จำกัด 100 instrument keys ต่อ cache และ 64 ช่วงต่อ key; restart/eviction ทำให้ต้องโหลดใหม่ ไม่มี background refresh
- ถ้าช่วงที่ขอเพิ่มติด rate limit ข้อมูลช่วงเดิมที่สำเร็จแล้วยังใช้ได้ ช่วงใหม่ไม่ถูกทำเครื่องหมายว่าครบ และจะรอ retry ตามเดิม Frontend ยังต้องรองรับ INCOMPLETE/null ไม่แทนด้วยศูนย์ การเปลี่ยนนี้ลดคำขอซ้ำ ไม่ได้ยกเลิก quota ของ provider

สคริปต์ทดสอบจริงด้านบนตรวจเพิ่มเติมว่า หลัง ALL แล้วเปลี่ยนช่วงกราฟทั้งห้าช่วงไม่มี provider calls เพิ่ม และ points ตรงกับส่วนเดียวกันของ ALL

## แยก limit ของ Backend กับ provider

สาเหตุที่ตรวจพบในโค้ดเดิม: รองรับ 30 historical instruments แต่ Yahoo history client ตั้ง rolling budget 20 ครั้ง/60 วินาทีและ reject ทันทีเมื่อเต็ม ดังนั้นตอน cold start/หมดอายุ cache/เติมช่วงใหม่ สินทรัพย์ที่ 21 อาจมี HISTORY_RATE_LIMITED ทั้งที่ Yahoo ยังไม่เคยได้รับคำขอนั้น การเข้าเว็บใหม่ไม่ได้รีเซ็ต budget และคำขอที่ล้มเหลวถูกจำตาม retryAt ข้อความเดิมของ frontend ใช้เพียง errorCode จึงไม่สามารถแยกจาก HTTP 429 ของ Yahoo ได้ ไม่ได้แปลว่าทุกครั้งที่เข้าเว็บจะขอข้อมูลใหม่ หรือว่า Yahoo เป็นฝ่ายจำกัดเสมอ

Yahoo history และ historical FX เปลี่ยนเป็น FIFO admission queue ที่รอ budget ได้สูงสุด 65 วินาที/คำขอเข้าคิว จำกัด 64 คำขอรอ ไม่เพิ่มเพดาน 20 ครั้ง/60 วินาที เครือข่ายแต่ละคำขอยัง timeout 10 วินาที คิวนี้เฉพาะการรับสิทธิ์เรียก provider ไม่ล็อก cache ทุกสินทรัพย์: HIT ส่งกลับได้โดยไม่รอคิวของตัวอื่น กรณีมี 21–30 ตัวตอน cold start อาจใช้เวลารอใกล้หนึ่งนาที หน้าเว็บควรแสดง loading และไม่ยิง retry อัตโนมัติทุกไม่กี่วินาที หากหลายผู้ใช้/หลายรอบเกินขอบเขตยังอาจได้ INCOMPLETE พร้อม retryAt ไม่รับประกันว่าทั้ง request จะจบภายใน 65 วินาที (ยังมี network/SEC pagination และหลายสินทรัพย์)

Yahoo ตอบ 429 หรือ 421 จะหยุดคำขอที่ยังไม่เริ่มของ client นั้นตาม Retry-After (เพดานที่ระบบรองรับ 1 ชั่วโมง ขั้นต่ำ 1 นาที) ไม่วน retry ระหว่าง cooldown ข้อมูลสำเร็จที่อยู่ใน cache ยังใช้ได้ ไม่ถูกลบเพราะอีกตัวถูกจำกัด SEC history ซึ่งใช้ client ร่วมกับ latest NAV มี diagnostics เหมือนกัน แต่ยังใช้ budget/การ fail-fast เดิม ไม่ได้เปลี่ยนคิวของ latest NAV/ราคาปัจจุบัน/โลโก้/ข่าว

Response เพิ่ม metadata ใน `positions[]` และ `fxHistory` (อันหลังใช้วิเคราะห์ Frankfurter historical FX เท่านั้น ไม่ใช่ endpoint exchange-rate ล่าสุด):

| Field | ความหมาย |
| --- | --- |
| errorCode | คงรหัสเดิม เช่น HISTORY_RATE_LIMITED / HISTORY_FX_RATE_LIMITED / NAV_RATE_LIMITED เพื่อ backward compatibility |
| limitSource | BACKEND = งบ/คิวของเรา; PROVIDER = provider ตอบจำกัดจริง; null = ไม่ใช่ rate limit หรือไม่ทราบ |
| reason | BACKEND_PER_MINUTE_LIMIT, BACKEND_QUEUE_FULL, BACKEND_QUEUE_TIMEOUT หรือ PROVIDER_RATE_LIMIT; timeout/network แยกเป็น PROVIDER_TIMEOUT / NETWORK_ERROR |
| providerStatus | เช่น 429 หรือ 421 เฉพาะเมื่อได้รับ HTTP error จริง ถ้าจำกัดก่อนส่งออกจะเป็น null |
| retryAt | ISO timestamp ที่ค่อยลองใหม่ได้ ไม่ใช่เวลาที่รับประกัน provider จะกลับมาใช้งาน |
| cacheStatus | HIT = ครบใน cache; MISS = โหลดใหม่; PARTIAL = ใช้ของเดิมและเติมช่วงที่ขาด; LOAD_FAILED = โหลดช่วงขาดไม่สำเร็จ; RETRY_WAIT = ใช้ข้อมูลความล้มเหลวที่จำไว้ ยังไม่เรียก provider ใหม่ |

ตัวอย่าง Yahoo จำกัดจริง:

```json
{
  "source": "YAHOO_FINANCE",
  "errorCode": "HISTORY_RATE_LIMITED",
  "limitSource": "PROVIDER",
  "reason": "PROVIDER_RATE_LIMIT",
  "providerStatus": 429,
  "retryAt": "2026-10-25T08:01:00.000Z",
  "cacheStatus": "LOAD_FAILED"
}
```

หาก Backend คิวเต็มจะเป็น limitSource=BACKEND, reason=BACKEND_QUEUE_FULL, providerStatus=null ถึง errorCode จะเหมือนตัวอย่าง ห้ามใช้ HTTP status ของ endpoint กราฟแทน providerStatus: กราฟยังคืน HTTP 200 + INCOMPLETE ตามสัญญาเดิม

แนวทาง frontend: ให้เลือกข้อความจาก limitSource/reason ก่อน errorCode เดิม เช่น BACKEND → “ระบบกำลังจัดคิวข้อมูลย้อนหลัง กรุณาลองใหม่ตามเวลาที่ระบุ”, PROVIDER → “ผู้ให้บริการจำกัดคำขอชั่วคราว” พร้อมชื่อ source ถ้ามี ใช้ retryAt ควบคุมปุ่มลองใหม่ และอย่ายิงซ้ำเมื่อยัง loading/ก่อน retryAt ไม่ต้องล้างกราฟเก่าที่ดีเพียงเพราะคำขอใหม่ INCOMPLETE แต่ต้องแยกให้เห็นว่าข้อมูลเก่าหรือบางส่วน ไม่ผสมเป็นกราฟใหม่ที่อ้างว่าครบ

`cacheStatus`, reason และ source มีไว้ช่วยวิเคราะห์ ไม่ได้เปิดเผยจำนวนโควต้าที่เหลือจริงของ Yahoo ไม่ส่ง raw error/provider body/URL ที่มี key ให้ client และยังไม่มี persistent cache หรือ shared limiter ข้ามหลาย process/server

ขณะพัฒนา `npm run dev` ใช้ Node watch การแก้ไฟล์ Backend อาจทำให้ process restart อัตโนมัติและ RAM cache เริ่มว่างอีกครั้ง แม้ผู้ใช้ไม่ได้กดปิด server เอง การ refresh/logout ที่ frontend เพียงอย่างเดียวไม่ควรล้าง public history cache

## ช่วงก่อน Yahoo เริ่มมีประวัติ (ช่วงสั้น → ALL)

แก้กรณีโหลด 1M ก่อนแล้วกด ALL: เมื่อ cache มีราคาช่วงหลังแล้ว การขอเติมช่วงเก่าที่อยู่ก่อนข้อมูลแรกของ Yahoo ทั้งช่วงอาจได้ HTTP 400 `Data doesn't exist ...` เดิมจึงทำให้ทั้ง instrument กลายเป็น UNAVAILABLE แม้ช่วงหลังมีราคาที่ใช้ได้อยู่

- ใช้ `meta.firstTradeDate` จาก Yahoo response ที่ผ่านการตรวจ symbol, currency, ตลาด และประเภทหลักทรัพย์แล้ว เป็นขอบเขตเริ่มต้นของข้อมูล ไม่ hardcode SPCX หรือรายชื่อหุ้น ใช้กับหุ้นนอก/ETF ที่รองรับและหุ้นไทยที่ดึง Yahoo เหมือนกัน ไม่เปลี่ยน SEC NAV หรือ Frankfurter FX
- ตรวจ timestamp/วันตาม timeZone ตลาด (New York หรือ Bangkok), ไม่รับอนาคต, และต้องไม่ขัดกับ observations/split events ใน response หาก metadata ไม่มี/ผิดรูปแบบ/ขัดกัน จะไม่เดาขอบเขตจากแท่งแรกของช่วงสั้น
- Metadata นี้หมายถึงวันที่เริ่มประวัติที่ Yahoo ระบุ ไม่ใช่การยืนยันวัน IPO หรือการยืนยันอัตลักษณ์ ticker ย้อนหลังทั้งหมด โดยเฉพาะกรณี reuse/rename ticker
- เมื่อเติม cache ถ้าช่วงที่ขาดอยู่ก่อนขอบเขตทั้งหมด จะจำเป็นช่วงที่ไม่มี observation โดยไม่ยิง Yahoo เพิ่ม หากช่วงที่ขาดคร่อมขอบเขต จะขอเฉพาะส่วนตั้งแต่วันแรกที่มีข้อมูลถึงปลายช่วงที่ขาด แล้วรวมกับราคาที่เคย cache ไว้
- ไม่มีการเพิ่มแถวราคา 0, copy ราคาวันแรกย้อนหลัง หรือเปลี่ยนรายการ PDF/จำนวนถือ/ต้นทุนเดิม ช่วงที่ยังไม่ได้ถือสินทรัพย์คำนวณพอร์ตตามรายการเดิมได้ หากมีรายการถือก่อน Yahoo มีราคา จุดนั้นยังเป็น null/INCOMPLETE และ HISTORICAL_PRICE_MISSING ไม่แอบแทนด้วยศูนย์ ส่วนวันที่หลังจากมีข้อมูลยังคำนวณได้
- ไม่ตีความ HTTP 400 ทุกกรณีว่าไม่มีประวัติ หาก error เกิดหลังวันเริ่มมีข้อมูล หรือยังไม่มี metadata ที่ผ่านการตรวจ ยังคืน diagnostics เดิมตามจริง ไม่กลืน malformed request/access/rate-limit/network error
- ขอบเขตและช่วงว่างที่อนุมานใช้เฉพาะ metadata จาก public cache ที่ยังสด อายุไม่เกิน 6 ชั่วโมงและผูกกับ key หลักทรัพย์เดิม ไม่ทำให้ metadata มีอายุยาวขึ้นเพียงเพราะกด ALL ซ้ำ เมื่อ restart/หมดอายุ ต้องดึงยืนยันใหม่ ไม่มี fallback ไปใช้ขอบเขตถาวรที่ไม่ได้ตรวจ

Response `positions[]` เพิ่ม `historyAvailableFrom` เป็น YYYY-MM-DD ตามวันตลาด หรือ null หากยังไม่ทราบ เช่น:

```json
{
  "symbol": "SPCX",
  "source": "YAHOO_FINANCE",
  "errorCode": null,
  "historyAvailableFrom": "2026-06-12",
  "cacheStatus": "HIT"
}
```

Frontend ใช้ field นี้แสดงคำอธิบายได้ เช่น “แหล่งข้อมูลมีประวัติตั้งแต่ 12 มิ.ย. 2026” ไม่ต้อง trim วันเริ่มกราฟทั้งพอร์ตเป็นวันนี้ เพราะสินทรัพย์อื่นอาจมีประวัติก่อนหน้านั้น ไม่ต้องคำนวณ split ซ้ำหรือแก้กราฟเมื่อเปลี่ยนช่วง: ใช้ points ที่ Backend คืนเหมือนเดิม ถ้าไม่มี errorCode ก็ไม่ควรแสดงข้อความ HTTP 400 เก่าจากคำขอก่อนหน้า

`cacheStatus=HIT` อาจเกิดแม้เพิ่งขอช่วงที่กว้างขึ้น หากส่วนที่เพิ่มอยู่ก่อนขอบเขตที่ทราบทั้งหมดและไม่ต้องเรียก provider; ถ้ายังต้องโหลดราคาเพิ่มจะเป็น PARTIAL ตามเดิม

ทดสอบจริงแบบช่วงสั้น → ALL และเทียบกับ ALL ตอน cache ว่างได้ด้วย `node --use-system-ca scripts/verification/verify-history-availability.cjs` ใช้ SPCX และ CRWV เป็นตัวอย่างกับราคาสาธารณะ ไม่อ่าน Supabase หรือข้อมูลผู้ใช้ ชุดทดสอบจำลองเพิ่ม unknown ticker/หุ้นไทย/metadata ผิด/วันตาม timezone/TTL/รายการก่อนข้อมูลแรก โดยไม่ผูกวิธีแก้กับสอง symbol ในสคริปต์

## Split/reverse split ข้ามหลายช่วง cache

แก้กรณี cache เริ่มในวัน split แล้วขยายย้อนก่อนวันนั้น: Yahoo คืน close ที่ปรับ split แล้ว แต่คำขอเติมช่วงเก่าอาจไม่มี event ที่อยู่ในช่วง cache เดิม หากปรับราคาจาก events ของแต่ละคำขอแยกกัน ราคาวันเดียวกันอาจต่างจาก ALL ตอน cache ว่าง แม้ API สำเร็จและ status=COMPLETE

แนวทางใหม่:

1. เก็บ Yahoo raw close โดยไม่ปัดเศษ พร้อม priceHint และวันฐาน adjustment ตามวันตลาดเมื่อโหลดไว้ใน cache ภายใน ไม่ normalize แยกแต่ละส่วนล่วงหน้า
2. หลังเติมช่วงที่ขาดครบ รวม split/reverse-split events ที่ยังสดของ instrument เดียวกันจากทุกช่วง ก่อน normalize ราคา ไม่อาศัยเฉพาะ events ของคำขอเติมช่วงเก่า
3. คืนราคาสู่ฐานหุ้นในวันนั้นด้วย decimal ratios แล้วค่อยปัดเศษที่ API boundary ด้วย precision ของ observation นั้น ป้องกันการเอาราคาที่ปัดแล้วมาคูณ/หาร ratio อีกที
4. แยกวันที่ฐาน adjustment ของ snapshot เดิม: event ที่เพิ่งเกิดหลังวันที่โหลด raw bar เดิมจะไม่ถูกย้อนคูณ/หารใส่ bar นั้นซ้ำ การเติมท้ายหลังเกิด action จึงไม่ทำให้ raw รุ่นก่อน action ถูกปรับสองครั้ง
5. Public response ยังคง `priceBasis=AS_TRADED_UNADJUSTED` และ points ราคา `{date,price}` แบบเดิม ข้อมูล raw/precision/normalization events ภายในไม่ถูกส่งให้ frontend ส่วน corporateActions สำหรับ replay จำนวนถือยังจำกัดตามช่วงที่ขอ ไม่ส่ง event อนาคตไปเปลี่ยนจำนวนในช่วงเก่า

ไม่แก้ PDF, orders, ต้นทุนหรือจำนวนถือปัจจุบัน ไม่แตะ Finnhub ล่าสุด/ดัชนี/SEC NAV/FX ไม่ hardcode symbol เป็นข้อยกเว้น และไม่เพิ่ม SQL หรือ `.env` ต้อง restart backend หลัง deploy เพื่อเริ่ม RAM cache รูปแบบใหม่

Frontend ใช้ points ที่ได้รับเหมือนเดิม ห้ามคูณ/หาร split หรือปรับจำนวนถือเพื่อแก้เส้นกราฟอีก ไม่มี field ที่ frontend ต้องนำไป normalize เอง การเปลี่ยนนี้แก้ความสอดคล้องเมื่อรวมช่วง ไม่ใช่การรับประกันว่า provider จะไม่แก้ประวัติหรือเปลี่ยนเวลาประกาศ ข้อจำกัดเรื่อง data gaps, การประกาศคนละตลาด และ corporate actions ที่ไม่ใช่ split ยังเหมือนเดิม

ทดสอบจริงด้วย `node --use-system-ca scripts/verification/verify-history-split-cache.cjs`: ใช้ NFLX forward split 10:1 และ SQQQ reverse split 1:5 กับราคาจริง + orders/FX จำลอง โดยไม่อ่านฐานข้อมูล ตรวจราคาแต่ละวันและทุกจุดมูลค่าพอร์ตระหว่าง cache ช่วงสั้นก่อน ALL กับ ALL ตอน cache ว่าง และตรวจว่าสลับ 1D/1W/1M/ALL ภายหลังไม่ขอ Yahoo เพิ่ม ชุดทดสอบจำลองเพิ่ม reverse 1:3, หลายเหตุการณ์, หลายช่วงไม่ติดกัน, precision และ cache ที่ข้ามวันเกิด action

## เปลี่ยนช่วงกราฟต้อง fetch ใหม่ทุกครั้งหรือไม่

แนวทาง implement frontend state/cache แบบเก็บช่วงที่เคยโหลด, derive จาก ALL, TTL, invalidation และการกัน response เก่าข้าม user/revision อยู่ใน [Frontend portfolio history cache guide](FRONTEND_PORTFOLIO_HISTORY_CACHE_GUIDE.md) เอกสารนี้ยังไม่ได้เพิ่มโค้ด frontend

ไม่จำเป็นต้องเรียก provider ใหม่ทุกครั้ง แยกเป็นสองชั้น:

- Frontend → Backend: flow ปัจจุบันเรียก endpoint ด้วย range ใหม่ได้ตามปกติ Backend อ่านรายการล่าสุดของผู้ใช้และ replay คำนวณช่วงนั้นใหม่ ทำให้เปลี่ยนช่วงแล้วไม่เผลอใช้จำนวนถือหรือรายการ import รุ่นเก่า
- Backend → Yahoo/SEC/Frankfurter: ถ้า public cache ครอบคลุมราคา/NAV/FX และ events ที่จำเป็นอยู่แล้ว จะไม่เรียกภายนอกซ้ำ ขอเฉพาะส่วนขาดหรือส่วนหมดอายุ ดังนั้น frontend fetch ใหม่ไม่ได้หมายถึงเสีย provider quota ใหม่เสมอไป

Frontend สามารถ implement การเก็บแต่ละ range ที่เคยโหลดและใช้ ALL ที่ครบเป็น source สำหรับตัดช่วงตามคู่มือ cache ที่ลิงก์ไว้ โดยไม่รวมจำนวนหุ้นคำนวณใหม่เอง ต้อง invalidate เมื่อ logout/เปลี่ยน user/นำเข้า-ลบรายการ/วันสิ้นสุดเปลี่ยนหรือ refresh ข้อมูล ห้ามใช้กราฟของ user ก่อนหน้าหรือแสดงกราฟเก่าว่าเป็นผลคำนวณใหม่โดยไม่ระบุ งานเอกสารนี้ยังไม่ได้ implement state/cache ใน frontend และไม่จำเป็นต้องเปลี่ยน frontend เพื่อให้การแก้ split/cache ฝั่ง Backend ทำงาน
