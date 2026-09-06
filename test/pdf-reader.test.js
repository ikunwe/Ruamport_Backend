const assert = require('node:assert/strict');
const test = require('node:test');

const {
  extractPdfText,
  hasPdfSignature,
  normalizePdfText,
} = require('../src/modules/ingestion/pdf/pdf-reader.service');

test('PDF signature validation rejects a renamed non-PDF file', () => {
  assert.equal(hasPdfSignature(Buffer.from('not a pdf')), false);
  assert.equal(hasPdfSignature(Buffer.from('%PDF-1.7\n')), true);
});

test('PDF text normalization preserves lines and removes noisy whitespace', () => {
  assert.equal(
    normalizePdfText(' Dime  Confirmation\r\n  AAPL\t 10  \n\n\n BUY '),
    'Dime Confirmation\nAAPL 10\n\nBUY',
  );
});

test('PDF reader extracts normalized text and destroys its parser', async () => {
  let destroyed = false;
  const parserFactory = () => ({
    async getText() {
      return { text: ' Dime   BUY ', pages: [{ num: 1 }] };
    },
    async destroy() {
      destroyed = true;
    },
  });

  const result = await extractPdfText(Buffer.from('%PDF-test'), undefined, parserFactory);

  assert.deepEqual(result, { text: 'Dime BUY', pageCount: 1 });
  assert.equal(destroyed, true);
});

test('PDF reader rejects a valid PDF with no extractable text', async () => {
  const parserFactory = () => ({
    async getText() {
      return { text: '', pages: [] };
    },
    async destroy() {},
  });

  await assert.rejects(
    extractPdfText(Buffer.from('%PDF-test'), undefined, parserFactory),
    { code: 'PDF_TEXT_NOT_FOUND' },
  );
});
