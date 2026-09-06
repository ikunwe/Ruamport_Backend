const assert = require('node:assert/strict');
const test = require('node:test');

const { parseDimeDocument } = require('../src/modules/ingestion/pdf/dime-document-parser.service');

const MUTUAL_FUND_TEXT = `
ใบยืนยันการซื้อขาย / ใบเสร็จรับเงิน / ใบกำกับภาษี
Confirmation Note / Receipt / Tax Invoice
Mutual Fund
101738738454892
DN 202608141359
DIMEMF20260811002540
11/08/2026
11/08/2026
เลขที่บัญชี
Account No.
วันที่คำสั่งมีผล
Effective Date
2202608110004728 SUB SCBS&P500 3.3902 0.49 100.00 29.4963
SUB ซื้อหน่วยลงทุน (Subscription)
RED ขายหน่วยลงทุน (Redemption)
SWI สับเปลี่ยนหน่วยลงทุนเข้า (Switch in)
SWO สับเปลี่ยนหน่วยลงทุนออก (Switch out)
Total Subscription
รวมมูลค่าซื้อ
รายละเอียดรายการ
100.00
The above transaction is correct.
0.00
รวมมูลค่าสับเปลี่ยนเข้า
Total Switch in
0.00
รวมมูลค่าขาย
Total Redemption
0.00
รวมมูลค่าสับเปลี่ยนออก
Total Switch out
0.46
ค่าธรรมเนียมไม่รวมภาษีมูลค่าเพิ่ม
Total Fee (Exclude VAT)
0.03
ภาษีมูลค่าเพิ่ม
Total Vat
0.04
ค่าใช้จ่ายในการซื้อขายหลักทรัพย์
Brokerage Expense paid to Fund
`;

test('auto-detects and parses a Dime mutual fund confirmation note', () => {
  const result = parseDimeDocument(MUTUAL_FUND_TEXT);

  assert.deepEqual(result.document, {
    type: 'DIME_MUTUAL_FUND_CONFIRMATION_NOTE',
    documentNumber: 'DN 202608141359',
    taxInvoiceNumber: 'DIMEMF20260811002540',
    accountNumber: '101738738454892',
    issueDate: '2026-08-11',
    effectiveDate: '2026-08-11',
    deduplicationKey: 'DIME_MUTUAL_FUND_CONFIRMATION_NOTE:DN-202608141359',
  });
  assert.deepEqual(result.orders, [{
    orderId: '2202608110004728',
    tradeDate: '2026-08-11',
    transactionCode: 'SUB',
    transactionType: 'SUBSCRIPTION',
    fundName: 'SCBS&P500',
    units: 3.3902,
    navPerUnit: 29.4963,
    currency: 'THB',
    totalAmount: 100,
    feeIncludeVat: 0.49,
  }]);
  assert.deepEqual(result.summary, {
    currency: 'THB',
    totalSubscription: 100,
    totalSwitchIn: 0,
    totalRedemption: 0,
    totalSwitchOut: 0,
    totalFeeExcludeVat: 0.46,
    totalVat: 0.03,
    totalFeeIncludeVat: 0.49,
    brokerageExpensePaidToFund: 0.04,
  });
  assert.deepEqual(result.calculation, { netCashFlow: -100, cashFlowType: 'CASH_OUT' });
  assert.deepEqual(result.validation, { isValid: true, warnings: [] });
});
