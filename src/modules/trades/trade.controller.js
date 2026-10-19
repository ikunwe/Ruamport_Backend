const { AppError } = require('../../shared/errors/app-error');
const { extractPdfText } = require('../ingestion/pdf/pdf-reader.service');
const { parseDimeDocument } = require('../ingestion/pdf/dime-document-parser.service');
const { createInvestmentService } = require('./investment.service');
function createPreviewPdf({ investments = createInvestmentService(), extract = extractPdfText, parse = parseDimeDocument } = {}) {
  return async function previewPdf(request, response) {
    if (!request.file) {
      throw new AppError(400, 'PDF_FILE_REQUIRED', 'Upload one PDF in the file field');
    }

    const password = request.body?.pdfPassword;
    const cached = await investments.cached(request.user.id, request.file.buffer);
    if (cached) {
      response.set('Cache-Control', 'no-store');
      return response.status(200).json({ ...cached.preview, record: cached.record });
    }
    const result = await extract(request.file.buffer, password);
    const parsed = parse(result.text);

    const stored = await investments.stage(request.user.id, request.file.buffer, {
      file: {
        name: request.file.originalname,
        size: request.file.size,
        mimeType: request.file.mimetype,
        pageCount: result.pageCount,
      },
      ...parsed,
    });
    response.set('Cache-Control', 'no-store');
    response.status(200).json({ ...stored.preview, record: stored.record });
  };
}

module.exports = { previewPdf: createPreviewPdf(), createPreviewPdf };
