import express from "express";
import axios from "axios";
import { PDFDocument } from "pdf-lib";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import os from "os";

// ==== إعدادات أساسية ====

const app = express();
const PORT = process.env.PORT || 3000;

// نسمح بـ JSON
app.use(express.json({ limit: "200mb" }));

// لحساب مسار الملف الحالي
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ==== Route اختبار السيرفر ====

app.get("/health", (req, res) => {
  return res.status(200).json({
    status: "ok",
    message: "PDF Pro Server is running",
  });
});

// ==== أدوات مساعدة ====

// إنشاء اسم ملف مؤقت
function createTempFileName(prefix = "pdf") {
  const random = Math.random().toString(36).substring(2, 10);
  return path.join(os.tmpdir(), `${prefix}-${Date.now()}-${random}.pdf`);
}

// حذف ملف بأمان (بدون ما نكسر السيرفر لو فشل)
function safeUnlink(filePath) {
  if (!filePath) return;
  fs.unlink(filePath, () => {});
}

// ==== الوظيفة الأساسية: تنزيل PDF من URL ====

async function downloadPdfToTempFile(url) {
  const tempPath = createTempFileName("source");

  const response = await axios({
    method: "GET",
    url,
    responseType: "stream",
  });

  return new Promise((resolve, reject) => {
    const writer = fs.createWriteStream(tempPath);

    response.data.pipe(writer);

    let error = null;
    writer.on("error", (err) => {
      error = err;
      writer.close();
      reject(err);
    });

    writer.on("close", () => {
      if (!error) {
        resolve(tempPath);
      }
    });
  });
}

// ==== الوظيفة الأساسية: "ضغط" / إعادة كتابة PDF ====

async function compressPdfFile(inputPath) {
  const outputPath = createTempFileName("compressed");

  const existingPdfBytes = fs.readFileSync(inputPath);

  // pdf-lib: إعادة إنشاء PDF – بتنضّف شوية، مش أقوى ضغط في العالم
  const pdfDoc = await PDFDocument.load(existingPdfBytes);
  const compressedPdfBytes = await pdfDoc.save({ useObjectStreams: true });

  fs.writeFileSync(outputPath, compressedPdfBytes);

  return outputPath;
}

// ==== Route: ضغط PDF من رابط =====

app.post("/compress", async (req, res) => {
  const startTime = Date.now();

  let sourcePath = null;
  let compressedPath = null;

  try {
    const { publicUrl } = req.body;

    if (!publicUrl || typeof publicUrl !== "string") {
      return res.status(400).json({
        ok: false,
        error: "publicUrl is required and must be a string",
      });
    }

    // حماية بسيطة: نتأكد إنه PDF
    if (!publicUrl.toLowerCase().includes(".pdf")) {
      return res.status(400).json({
        ok: false,
        error: "Provided URL does not look like a PDF",
      });
    }

    // 1) تنزيل PDF إلى ملف مؤقت
    sourcePath = await downloadPdfToTempFile(publicUrl);

    // فحص الحجم (مثال: 150MB حد أقصى)
    const stats = fs.statSync(sourcePath);
    const maxSizeBytes = 150 * 1024 * 1024;
    if (stats.size > maxSizeBytes) {
      safeUnlink(sourcePath);
      return res.status(413).json({
        ok: false,
        error: "File too large. Max allowed size is 150MB",
      });
    }

    // 2) "ضغط" / إعادة كتابة PDF
    compressedPath = await compressPdfFile(sourcePath);

    const originalSize = stats.size;
    const compressedSize = fs.statSync(compressedPath).size;
    const ratio =
      originalSize > 0 ? (1 - compressedSize / originalSize) * 100 : 0;

    // 3) إعداد الرد
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      'attachment; filename="compressed.pdf"'
    );

    const readStream = fs.createReadStream(compressedPath);

    readStream.on("error", (err) => {
      console.error("Error streaming compressed PDF:", err);
      if (!res.headersSent) {
        return res
          .status(500)
          .json({ ok: false, error: "Error streaming compressed file" });
      }
    });

    readStream.pipe(res);

    readStream.on("close", () => {
      const duration = Date.now() - startTime;
      console.log(
        `Compression done. Original: ${(
          originalSize /
          (1024 * 1024)
        ).toFixed(2)}MB, Compressed: ${(compressedSize / (1024 * 1024)).toFixed(
          2
        )}MB, Saved: ${ratio.toFixed(2)}%, Time: ${duration}ms`
      );
      safeUnlink(sourcePath);
      safeUnlink(compressedPath);
    });
  } catch (err) {
    console.error("Error in /compress:", err);
    safeUnlink(sourcePath);
    safeUnlink(compressedPath);

    if (!res.headersSent) {
      return res.status(500).json({
        ok: false,
        error: "Internal server error while compressing PDF",
        detail: err?.message || "Unknown error",
      });
    }
  }
});

// ==== تشغيل السيرفر محليًا ====

app.listen(PORT, () => {
  console.log(`PDF Pro Server running on port ${PORT}`);
});
