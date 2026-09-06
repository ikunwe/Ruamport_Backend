const {
  PDFParse,
  PasswordException,
  InvalidPDFException,
  FormatError,
} = require('pdf-parse');

const { AppError } = require('../../../shared/errors/app-error');

const PDF_SIGNATURE = Buffer.from('%PDF-');
const MAX_PASSWORD_LENGTH = 128;

function hasPdfSignature(buffer) {
  return Buffer.isBuffer(buffer)
    && buffer.length >= PDF_SIGNATURE.length
    && buffer.subarray(0, PDF_SIGNATURE.length).equals(PDF_SIGNATURE);
}

function normalizePdfText(text) {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\t\f\v ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function extractPdfText(buffer, password, parserFactory = (options) => new PDFParse(options)) {
  if (!hasPdfSignature(buffer)) {
    throw new AppError(400, 'INVALID_PDF', 'The uploaded file does not have a valid PDF signature');
  }

  if (password !== undefined && (typeof password !== 'string' || password.length > MAX_PASSWORD_LENGTH)) {
    throw new AppError(400, 'INVALID_PDF_PASSWORD', 'PDF password must be a string of at most 128 characters');
  }

  const parser = parserFactory({
    data: new Uint8Array(buffer),
    password: password || undefined,
  });

  try {
    const result = await parser.getText();
    const text = normalizePdfText(result.text);

    if (!text) {
      throw new AppError(422, 'PDF_TEXT_NOT_FOUND', 'No selectable text was found in the PDF');
    }

    return {
      text,
      pageCount: Array.isArray(result.pages) ? result.pages.length : null,
    };
  } catch (error) {
    if (error instanceof AppError) throw error;

    if (error instanceof PasswordException || error?.name === 'PasswordException') {
      const passwordWasProvided = typeof password === 'string' && password.length > 0;
      throw new AppError(
        422,
        passwordWasProvided ? 'PDF_PASSWORD_INVALID' : 'PDF_PASSWORD_REQUIRED',
        passwordWasProvided ? 'The PDF password is incorrect' : 'This PDF requires a password',
      );
    }

    if (
      error instanceof InvalidPDFException
      || error instanceof FormatError
      || error?.name === 'InvalidPDFException'
      || error?.name === 'FormatError'
    ) {
      throw new AppError(422, 'PDF_PARSE_FAILED', 'The PDF is invalid or unsupported');
    }

    throw error;
  } finally {
    if (typeof parser.destroy === 'function') {
      await parser.destroy();
    }
  }
}

module.exports = { extractPdfText, hasPdfSignature, normalizePdfText };
