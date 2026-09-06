const multer = require('multer');

const { AppError } = require('../shared/errors/app-error');

const MAX_PDF_SIZE_BYTES = 10 * 1024 * 1024;

const uploadPdf = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_PDF_SIZE_BYTES,
    files: 1,
    fields: 2,
    parts: 3,
  },
  fileFilter(_request, file, callback) {
    const hasPdfName = file.originalname.toLowerCase().endsWith('.pdf');
    const hasPdfMime = file.mimetype === 'application/pdf';

    if (!hasPdfName && !hasPdfMime) {
      callback(new AppError(415, 'PDF_FILE_REQUIRED', 'Only PDF files are accepted'));
      return;
    }

    callback(null, true);
  },
}).single('file');

module.exports = { uploadPdf, MAX_PDF_SIZE_BYTES };
