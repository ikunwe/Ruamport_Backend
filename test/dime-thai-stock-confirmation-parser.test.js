const assert = require('node:assert/strict');
const test = require('node:test');

const { parseDimeDocument } = require('../src/modules/ingestion/pdf/dime-document-parser.service');

const THAI_STOCK_TEXT = `
ใบยืนยันการซื้อขาย / ใบเสร็จรับเงิน / ใบกำกับภาษี
Confirmation Note / Receipt / Tax Invoice
Cash Balance
97507514
TH2026090300011218
DIMETH2026090300011218
03/09/2026
03/09/2026
เลขที่บัญชี
Account No.
วันที่ซื้อขาย
Effective Date
031642183181 BUY ASK 5.00 0.08 51.09 10.20 07/09/2026 51.00 0.01
BUY
SEL
REW
Total Buy
รวมมูลค่าซื้อ (THB)
รายละเอียดรายการ
51.09
The above transaction is correct.
0.00
รวมมูลค่าขาย (THB)
Total Sell
0.08
ค่าธรรมเนียมไม่รวมภาษีมูลค่าเพิ่ม
Total Fee (Exclude VAT)
0.01
ภาษีมูลค่าเพิ่ม (THB)
Total Vat
51.09
ลูกค้าจ่ายเงินสุทธิ
Net Customer Paid
`;

test('auto-detects and parses a Dime Thai stock confirmation note', () => {
  const result = parseDimeDocument(THAI_STOCK_TEXT);

  assert.deepEqual(result.document, {
    type: 'DIME_THAI_STOCK_CONFIRMATION_NOTE',
    documentNumber: 'TH2026090300011218',
    taxInvoiceNumber: 'DIMETH2026090300011218',
    accountNumber: '97507514',
    issueDate: '2026-09-03',
    effectiveDate: '2026-09-03',
    deduplicationKey: 'DIME_THAI_STOCK_CONFIRMATION_NOTE:TH2026090300011218',
  });
  assert.deepEqual(result.orders, [{
    orderId: '031642183181',
    tradeDate: '2026-09-03',
    settlementDate: '2026-09-07',
    transactionCode: 'BUY',
    transactionType: 'BUY',
    symbol: 'ASK',
    units: 5,
    pricePerShare: 10.2,
    currency: 'THB',
    grossAmount: 51,
    feeExcludeVat: 0.08,
    vat: 0.01,
    totalAmount: 51.09,
  }]);
  assert.deepEqual(result.summary, {
    currency: 'THB',
    totalBuy: 51.09,
    totalSell: 0,
    totalFeeExcludeVat: 0.08,
    totalVat: 0.01,
    netCustomerAmount: 51.09,
    netCustomerDirection: 'PAID',
  });
  assert.deepEqual(result.calculation, {
    totalFeesAndTaxes: 0.09,
    netCashFlow: -51.09,
    cashFlowType: 'CASH_OUT',
  });
  assert.deepEqual(result.validation, { isValid: true, warnings: [] });
});
