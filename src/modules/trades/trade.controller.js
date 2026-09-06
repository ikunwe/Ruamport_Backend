const { AppError } = require('../../shared/errors/app-error');
const { extractPdfText } = require('../ingestion/pdf/pdf-reader.service');
const { parseDimeDocument } = require('../ingestion/pdf/dime-document-parser.service');

async function previewPdf(request, response) {
  if (!request.file) {
    throw new AppError(400, 'PDF_FILE_REQUIRED', 'Upload one PDF in the file field');
  }

  const password = request.body?.pdfPassword;
  const result = await extractPdfText(request.file.buffer, password);
  const parsed = parseDimeDocument(result.text);

  response.status(200).json({
    file: {
      name: request.file.originalname,
      size: request.file.size,
      mimeType: request.file.mimetype,
      pageCount: result.pageCount,
    },
    ...parsed,
  });
}

module.exports = { previewPdf };
