// ==============================
// إعدادات وتهيئة السيرفر
// ==============================
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const { PDFDocument } = require("pdf-lib");
const pdfParse = require("pdf-parse");

const app = express();

// CORS مع إمكانية تخصيص الدومين لاحقًا
app.use(cors({
  origin: "*", // غيّرها لدومين واجهتك في الإنتاج لو حابب
  methods: ["GET", "POST"],
  allowedHeaders: ["Content-Type"]
}));

app.use(express.json());

// ==============================
// إعداد رفع الملفات (Multer)
// ==============================

const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25MB
const ALLOWED_MIME_TYPES = ["application/pdf"];

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_FILE_SIZE
  },
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_MIME_TYPES.includes(file.mimetype)) {
      return cb(new Error("النوع المسموح به هو PDF فقط"));
    }
    cb(null, true);
  }
});

// Middleware عام للتعامل مع أخطاء Multer
function multerErrorHandler(err, req, res, next) {
  if (err instanceof multer.MulterError) {
    if (err.code === "LIMIT_FILE_SIZE") {
      return res.status(400).json({ error: "حجم الملف أكبر من الحد المسموح به" });
    }
    return res.status(400).json({ error: "خطأ في رفع الملف", details: err.message });
  } else if (err) {
    return res.status(400).json({ error: err.message || "خطأ في الملف" });
  }
  next();
}

// ==============================
// دوال مساعدة (Helpers)
// ==============================

// رد موحّد للنجاح
function sendJson(res, data, status = 200) {
  return res.status(status).json({ success: true, ...data });
}

// رد موحّد للخطأ
function sendError(res, message, status = 400, extra = {}) {
  console.error("❌ Error:", message, extra);
  return res.status(status).json({ success: false, error: message, ...extra });
}

// التحقق من وجود ملف
function ensureFile(req, res) {
  if (!req.file) {
    sendError(res, "لا يوجد ملف PDF في الطلب", 400);
    return false;
  }
  return true;
}

// التحقق من وجود ملفات متعددة
function ensureFiles(req, res) {
  if (!req.files || req.files.length === 0) {
    sendError(res, "لا توجد ملفات PDF في الطلب", 400);
    return false;
  }
  return true;
}

// ==============================
// Route اختبار
// ==============================
app.get("/", (req, res) => {
  sendJson(res, { message: "✅ السيرفر شغال بقوة يا محمود" });
});

// ==============================
// 1) Split PDF  (/split)
// ==============================
// يستقبل: file (PDF), startPage, endPage
// يرجّع: PDF جديد بالصفحات المطلوبة
app.post(
  "/split",
  upload.single("file"),
  multerErrorHandler,
  async (req, res) => {
    try {
      if (!ensureFile(req, res)) return;

      let { startPage, endPage } = req.body;

      if (!startPage) return sendError(res, "startPage مطلوب", 400);
      startPage = parseInt(startPage, 10);
      endPage = endPage ? parseInt(endPage, 10) : startPage;

      if (isNaN(startPage) || isNaN(endPage)) {
        return sendError(res, "startPage و endPage يجب أن يكونوا أرقام صحيحة", 400);
      }

      const originalPdf = await PDFDocument.load(req.file.buffer);
      const totalPages = originalPdf.getPageCount();

      const safeStart = Math.max(1, Math.min(startPage, totalPages));
      const safeEnd = Math.max(safeStart, Math.min(endPage, totalPages));

      if (safeStart > safeEnd) {
        return sendError(res, "نطاق الصفحات غير صحيح", 400, { totalPages });
      }

      const newPdf = await PDFDocument.create();
      const indices = [];
      for (let i = safeStart - 1; i < safeEnd; i++) indices.push(i);

      const copiedPages = await newPdf.copyPages(originalPdf, indices);
      copiedPages.forEach(page => newPdf.addPage(page));

      const pdfBytes = await newPdf.save();

      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", "attachment; filename=split.pdf");
      res.send(Buffer.from(pdfBytes));
    } catch (err) {
      console.error("خطأ في /split:", err);
      sendError(res, "حدث خطأ أثناء تقسيم الملف", 500);
    }
  }
);

// ==============================
// 2) Merge PDF  (/merge)
// ==============================
// يستقبل: files[] (عدة ملفات PDF)
// يرجّع: ملف PDF واحد مدموج
app.post(
  "/merge",
  upload.array("files", 15),
  multerErrorHandler,
  async (req, res) => {
    try {
      if (!ensureFiles(req, res)) return;

      const mergedPdf = await PDFDocument.create();

      for (const file of req.files) {
        try {
          const pdf = await PDFDocument.load(file.buffer);
          const copiedPages = await mergedPdf.copyPages(
            pdf,
            pdf.getPageIndices()
          );
          copiedPages.forEach(page => mergedPdf.addPage(page));
        } catch (fileErr) {
          console.error("ملف غير صالح أثناء الدمج:", file.originalname);
        }
      }

      if (mergedPdf.getPageCount() === 0) {
        return sendError(res, "لم يتم دمج أي صفحات. ربما كل الملفات تالفة.", 400);
      }

      const pdfBytes = await mergedPdf.save();

      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", "attachment; filename=merged.pdf");
      res.send(Buffer.from(pdfBytes));
    } catch (err) {
      console.error("خطأ في /merge:", err);
      sendError(res, "حدث خطأ أثناء دمج الملفات", 500);
    }
  }
);

// ==============================
// 3) Compress PDF  (/compress)
// ==============================
// ضغط مبدئي: إعادة بناء الملف، تقليل Streams، مناسب كبداية
app.post(
  "/compress",
  upload.single("file"),
  multerErrorHandler,
  async (req, res) => {
    try {
      if (!ensureFile(req, res)) return;

      const originalSize = req.file.buffer.length;
      const pdfDoc = await PDFDocument.load(req.file.buffer, {
        ignoreEncryption: true
      });

      const pdfBytes = await pdfDoc.save({
        useObjectStreams: true
      });

      const newSize = pdfBytes.length;

      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", "attachment; filename=compressed.pdf");
      res.send(Buffer.from(pdfBytes));

      console.log(`ضغط PDF من ${originalSize} إلى ${newSize} بايت`);
    } catch (err) {
      console.error("خطأ في /compress:", err);
      sendError(res, "حدث خطأ أثناء ضغط الملف", 500);
    }
  }
);

// ==============================
// 4) Extract Text  (/extract-text)
// ==============================
// يستقبل: file (PDF)
// يرجّع: JSON فيه النص
app.post(
  "/extract-text",
  upload.single("file"),
  multerErrorHandler,
  async (req, res) => {
    try {
      if (!ensureFile(req, res)) return;

      const data = await pdfParse(req.file.buffer);
      const text = data.text || "";

      sendJson(res, {
        text,
        pages: data.numpages || null,
        info: data.info || null
      });
    } catch (err) {
      console.error("خطأ في /extract-text:", err);
      sendError(res, "حدث خطأ أثناء استخراج النص", 500);
    }
  }
);

// ==============================
// 5) Extract Pages  (/extract-pages)
// ==============================
// يستقبل: file (PDF), pages (مثال: "1,3,5-7")
// يرجّع: PDF جديد فيه الصفحات المطلوبة
function parsePagesExpression(pagesExpression, totalPages) {
  const pages = new Set();
  const parts = pagesExpression.split(",").map(p => p.trim()).filter(Boolean);

  for (const part of parts) {
    if (part.includes("-")) {
      const [startStr, endStr] = part.split("-").map(x => x.trim());
      let start = parseInt(startStr, 10);
      let end = parseInt(endStr, 10);
      if (isNaN(start) || isNaN(end)) continue;
      if (start > end) [start, end] = [end, start];

      start = Math.max(1, start);
      end = Math.min(totalPages, end);

      for (let i = start; i <= end; i++) {
        pages.add(i);
      }
    } else {
      const p = parseInt(part, 10);
      if (!isNaN(p) && p >= 1 && p <= totalPages) {
        pages.add(p);
      }
    }
  }

  return Array.from(pages).sort((a, b) => a - b);
}

app.post(
  "/extract-pages",
  upload.single("file"),
  multerErrorHandler,
  async (req, res) => {
    try {
      if (!ensureFile(req, res)) return;

      const { pages } = req.body;
      if (!pages || typeof pages !== "string") {
        return sendError(res, "يجب إرسال قائمة الصفحات (مثال: 1,3,5-7)", 400);
      }

      const originalPdf = await PDFDocument.load(req.file.buffer);
      const totalPages = originalPdf.getPageCount();

      const pageNumbers = parsePagesExpression(pages, totalPages);

      if (pageNumbers.length === 0) {
        return sendError(res, "لا يوجد صفحات صالحة في الطلب", 400, { totalPages });
      }

      const newPdf = await PDFDocument.create();
      const zeroBasedIndices = pageNumbers.map(p => p - 1);
      const copiedPages = await newPdf.copyPages(originalPdf, zeroBasedIndices);
      copiedPages.forEach(page => newPdf.addPage(page));

      const pdfBytes = await newPdf.save();

      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", "attachment; filename=extracted-pages.pdf");
      res.send(Buffer.from(pdfBytes));
    } catch (err) {
      console.error("خطأ في /extract-pages:", err);
      sendError(res, "حدث خطأ أثناء استخراج الصفحات", 500);
    }
  }
);

// ==============================
// تشغيل السيرفر محليًا
// ==============================
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`✅ السيرفر شغال بقوة على http://localhost:${PORT}`);
});
