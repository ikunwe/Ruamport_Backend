const assert = require('node:assert/strict');
const test = require('node:test');

const {
  parseDimeOffshoreConfirmation,
  parseNumber,
} = require('../src/modules/ingestion/pdf/dime-parser.service');

const DIME_TEXT = `
ใบยืนยันการซื้อขาย / ใบเสร็จรับเงิน / ใบกำกับภาษี
Confirmation Note / Receipt / Tax Invoice
80000834017
2026082500095303
DIMEOS20260825095303
19/08/2026
18/08/2026
เลขที่บัญชี
Account No.
วันที่คำสั่งมีผล
Effective Date
เลขที่คำสั่ง
Order ID
วันที่ครบ
Settlement Date Transaction Type
ประเภท ชื่อหลักทรัพย์
Securities
จำนวนหน่วย
Unit
ราคาต่อหน่วย
Unit Price Currency
219884 25/08/2026 BUY RKLB
[XNAS]
0.4331164 69.15 USD 29.95 0.05
1.62
0.00
0.00
30.00
974.49 972.87
1 / แผ่นที่ / Page Example 2
Client receipt/payment by Offshore Account
Total Buy
974.49
0.00
1.52
0.00
0.11
24 สิงหาคม 2569
24 August 2026
32.4831
รวมมูลค่าขาย (THB)
Total Sell
Total Fee (Exclude VAT)
ค่าธรรมเนียมไม่รวมภาษีมูลค่าเพิ่ม
Total Vat
ภาษีมูลค่าเพิ่ม (THB)
Withholding Tax
ภาษีหัก ณ ที่จ่าย (THB)
`;

test('parses accounting numbers including parentheses', () => {
  assert.equal(parseNumber('1,234.56'), 1234.56);
  assert.equal(parseNumber('(1.23)'), -1.23);
});

test('extracts Dime orders and document totals without returning raw text', () => {
  const result = parseDimeOffshoreConfirmation(DIME_TEXT);

  assert.equal(result.orders.length, 1);
  assert.deepEqual(result.document, {
    type: 'DIME_OFFSHORE_CONFIRMATION_NOTE',
    documentNumber: '2026082500095303',
    taxInvoiceNumber: 'DIMEOS20260825095303',
    accountNumber: '80000834017',
    issueDate: '2026-08-19',
    effectiveDate: '2026-08-18',
    deduplicationKey: 'DIME_OFFSHORE_CONFIRMATION_NOTE:2026082500095303',
  });
  assert.deepEqual(result.orders[0], {
    orderId: '219884',
    tradeDate: '2026-08-18',
    settlementDate: '2026-08-25',
    transactionCode: 'BUY',
    transactionType: 'BUY',
    symbol: 'RKLB',
    exchange: 'XNAS',
    units: 0.4331164,
    unitPrice: 69.15,
    currency: 'USD',
    grossAmount: { foreign: 29.95, thb: 972.87 },
    feeIncludeVat: { foreign: 0.05, thb: 1.62 },
    withholdingTax: { foreign: 0, thb: 0 },
    totalAmount: { foreign: 30, thb: 974.49 },
  });
  assert.deepEqual(result.summary, {
    currency: 'THB',
    totalBuy: 974.49,
    totalSell: 0,
    totalFeeExcludeVat: 1.52,
    discount: 0,
    totalFeeAfterDiscountExcludeVat: 1.52,
    totalVat: 0.11,
    withholdingTax: 0,
  });
  assert.deepEqual(result.calculation, {
    totalFeeIncludeVatAfterDiscount: 1.63,
    totalFeesAndTaxes: 1.63,
    netCashFlow: -974.49,
    cashFlowType: 'CASH_OUT',
  });
  assert.deepEqual(result.validation, { isValid: true, warnings: [] });
  assert.equal(Object.hasOwn(result, 'text'), false);
  assert.equal(Object.hasOwn(result, 'textPreview'), false);
});

test('subtracts discount before adding VAT to the total fee', () => {
  const textWithDiscount = DIME_TEXT.replace(
    '974.49\n0.00\n1.52\n0.00\n0.11',
    '974.49\n0.00\n4.61\n0.00\n0.24',
  ).concat(
    '\n3.38\n(1.23) Discount\nส่วนลด (THB)\nTotal Fee After Discount\nค่าธรรมเนียมหลังหักส่วนลด\nไม่รวมภาษีมูลค่าเพิ่ม (THB)\n(Exclude VAT)',
  );
  const result = parseDimeOffshoreConfirmation(textWithDiscount);

  assert.equal(result.summary.discount, 1.23);
  assert.equal(result.summary.totalFeeAfterDiscountExcludeVat, 3.38);
  assert.equal(result.calculation.totalFeeIncludeVatAfterDiscount, 3.62);
  assert.equal(result.calculation.totalFeesAndTaxes, 3.62);
  assert.deepEqual(result.validation, { isValid: true, warnings: [] });
});

test('maps the Dime SEL code to a SELL transaction', () => {
  const sellText = DIME_TEXT
    .replace('19/08/2026\n18/08/2026', '11/05/2026\n08/05/2026')
    .replace(
      '219884 25/08/2026 BUY RKLB\n[XNAS]\n0.4331164 69.15 USD 29.95 0.05\n1.62\n0.00\n0.00\n30.00\n974.49 972.87',
      '451490 11/05/2026 SEL RKLB\n[XNAS]\n2.0000000 100.20 USD 200.40 0.32\n10.27\n0.00\n0.00\n200.08\n6,423.43 6,433.70',
    )
    .replace(
      '974.49\n0.00\n1.52\n0.00\n0.11\n24 สิงหาคม 2569',
      '0.00\n6,423.43\n9.60\n0.00\n0.67\n08 พฤษภาคม 2569',
    )
    .concat(
      '\n9.60\n0.00 Discount\nส่วนลด (THB)\nTotal Fee After Discount\nค่าธรรมเนียมหลังหักส่วนลด\nไม่รวมภาษีมูลค่าเพิ่ม (THB)\n(Exclude VAT)',
    );
  const result = parseDimeOffshoreConfirmation(sellText);

  assert.equal(result.orders.length, 1);
  assert.equal(result.orders[0].transactionType, 'SELL');
  assert.equal(result.orders[0].transactionCode, 'SEL');
  assert.equal(result.orders[0].tradeDate, '2026-05-08');
  assert.equal(result.orders[0].settlementDate, '2026-05-11');
  assert.equal(result.orders[0].totalAmount.thb, 6423.43);
  assert.equal(result.summary.totalSell, 6423.43);
  assert.equal(result.calculation.netCashFlow, 6423.43);
  assert.equal(result.calculation.cashFlowType, 'CASH_IN');
  assert.deepEqual(result.validation, { isValid: true, warnings: [] });
});

test('reads reward and option exercise transaction codes', () => {
  const specializedOrders = ['REW', 'EXC', 'EXP'].map((code, index) => `
${String(100001 + index)} 25/08/2026 ${code} RKLB
[XNAS]
1.0000000 10.00 USD 10.00 0.00
0.00
0.00
0.00
10.00
330.00 330.00`).join('');

  const orders = require('../src/modules/ingestion/pdf/dime-parser.service')
    .extractOrders(specializedOrders, '2026-08-24');

  assert.deepEqual(
    orders.map(({ transactionCode, transactionType }) => ({ transactionCode, transactionType })),
    [
      { transactionCode: 'REW', transactionType: 'REWARD' },
      { transactionCode: 'EXC', transactionType: 'EXERCISE_CALL' },
      { transactionCode: 'EXP', transactionType: 'EXERCISE_PUT' },
    ],
  );
});

test('rejects PDFs that are not recognized as Dime confirmations', () => {
  assert.throws(() => parseDimeOffshoreConfirmation('unrelated document'), {
    code: 'NOT_DIME_CONFIRMATION',
  });
});
