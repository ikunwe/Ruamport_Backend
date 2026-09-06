const assert = require('node:assert/strict');
const test = require('node:test');

const { parseDimeDocument } = require('../src/modules/ingestion/pdf/dime-document-parser.service');

const MONTHLY_TEXT = `
รายงานบัญชีหลักทรัพย์ต่างประเทศประจำเดือน
Offshore Securities Account Monthly Statement
80000834017
มิถุนายน 2569 / June 2026
1,441.35 USD
มูลค่าเงินลงทุนรวม / Total Balance
≈ 47,714.61 THB
ผลตอบแทนจากการลงทุน / Investment Return
≈ 5,127.62 THB + 12.04% (+154.89 USD)
ข้อมูล ณ 30 มิถุนายน 2569 / As of 30 June 2026 1 USD = 33.10 THB
ยอดเงินคงเหลือในบัญชี / Cash Balance
31.84 USD
≈ 1,054.04 THB
Allocation Group by Sector
หุ้นสามัญ
Common Stock
สัดส่วนการลงทุนจัดกลุ่มโดยกลุ่มอุตสาหกรรม
1,441.35 USD
≈ 47,714.61 THB
100.00%
สินค้าฟุ่มเฟือย
Consumer Cyclical
605.47 USD
≈ 20,043.63 THB
42.01%
อุตสาหกรรม
Industrials
371.72 USD
≈ 12,305.65 THB
25.79%
เทคโนโลยี
Technology
298.58 USD
≈ 9,884.35 THB
20.71%
การสื่อสาร
Communication Services
165.57 USD
≈ 5,480.98 THB
11.49%
1 / หน้าที่ / Page Example 6
รายละเอียดการลงทุน / Investment Information
สกุลเงิน / Currency USD
หุ้นสามัญ / Common Stock
GOOGL
Alphabet Inc. Class A Common
11.49% 0.4632944 251.11 357.37 + 42.31% + 49.23 165.57
NVDA
Nvidia Corp
20.71% 1.4922429 187.74 200.09 + 6.58% + 18.43 298.58
RKLB
Rocket Lab Corporation Common
20.37% 2.8889363 91.44 101.65 + 11.17% + 29.51 293.66
SPCX
Space Exploration Technologies
5.42% 0.4568908 185.73 170.86 - 8.01% - 6.80 78.06
TSLA
Tesla, Inc. Common Stock
42.01% 1.4395412 375.78 420.60 + 11.93% + 64.52 605.47
รวม 100.00% + 12.04% + 154.89 1,441.35
`;

test('auto-detects and parses a Dime monthly statement', () => {
  const result = parseDimeDocument(MONTHLY_TEXT);

  assert.deepEqual(result.document, {
    type: 'DIME_MONTHLY_STATEMENT',
    documentNumber: null,
    statementMonth: '2026-06',
    asOfDate: '2026-06-30',
    accountNumber: '80000834017',
    baseCurrency: 'USD',
    exchangeRate: { from: 'USD', to: 'THB', rate: 33.1, source: 'BOT' },
    deduplicationKey: 'DIME_MONTHLY_STATEMENT:80000834017:2026-06',
  });
  assert.deepEqual(result.overview, {
    portfolioValue: { usd: 1441.35, thb: 47714.61 },
    cashBalance: { usd: 31.84, thb: 1054.04 },
    totalAccountValue: { usd: 1473.19, thb: 48768.65, derived: true },
    investmentReturn: {
      percentage: 12.04,
      usd: 154.89,
      thb: 5127.62,
      includesDividends: false,
    },
  });
  assert.equal(result.assetAllocation.assetClasses[0].allocationPercentage, 100);
  assert.equal(result.assetAllocation.sectors.length, 4);
  assert.equal(result.holdings.length, 5);
  assert.equal(result.holdings[3].symbol, 'SPCX');
  assert.equal(result.holdings[3].totalReturnPercentage, -8.01);
  assert.equal(result.holdings[3].totalReturn, -6.8);
  assert.deepEqual(result.validation, { isValid: true, warnings: [] });
});
