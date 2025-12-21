import express from "express";
import cors from "cors";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import fs from "fs";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";
import pdfParse from "pdf-parse";
import multer from "multer"; // مكتبة للتعامل مع رفع الملفات مباشرة

// ====== Configuration ======
const app = express();
const PORT = process.env.PORT || 3000;
const MAX_SIZE_BYTES = 150 * 1024 * 1024; // 150MB

// إعداد multer لتخزين الملفات المرفوعة مؤقتاً في مجلد النظام
const upload = multer({ dest: os.tmpdir() });

app.use(express.json({ limit: "200mb" }));
app.use(cors());

// Path Helpers
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ====== Helpers ======

function createTempPath(prefix = "output") {
  return path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).substring(7)}.pdf`);
}

function safeDelete(filePath) {
  if (filePath && fs.existsSync(filePath)) {
    try { fs.unlinkSync(filePath); } catch (e) {}
  }
}

function sendPdfAndCleanup(res, filePath, fileName, extraCleanup = []) {
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
  
  const stream = fs.createReadStream(filePath);
  stream.pipe(res);
  stream.on("close", () => {
    safeDelete(filePath);
    extraCleanup.forEach(safeDelete);
  });
}

// ====== Routes ======

app.get("/", (req, res) => {
  res.json({ ok: true, message: "PDF Server Pro (No-DB Version) is running." });
});

// 1) دمج الملفات - يستقبل الآن مصفوفة من الملفات المرفوعة مباشرة
app.post("/merge", upload.array("files"), async (req, res) => {
  const files = req.files;
  if (!files || files.length < 2) {
    return res.status(400).json({ ok: false, error: "يرجى رفع ملفين على الأقل للدمج" });
  }

  let mergedPath = createTempPath("merged");
  try {
    const mergedDoc = await PDFDocument.create();
    for (const file of files) {
      const bytes = fs.readFileSync(file.path);
      const pdf = await PDFDocument.load(bytes);
      const copiedPages = await mergedDoc.copyPages(pdf, pdf.getPageIndices());
      copiedPages.forEach((page) => mergedDoc.addPage(page));
    }

    const mergedBytes = await mergedDoc.save();
    fs.writeFileSync(mergedPath, mergedBytes);

    // إرسال الملف المدمج وتنظيف الملفات المؤقتة
    sendPdfAndCleanup(res, mergedPath, "merged_document.pdf", files.map(f => f.path));
  } catch (err) {
    console.error(err);
    files.forEach(f => safeDelete(f.path));
    res.status(500).json({ ok: false, error: "فشل دمج الملفات" });
  }
});

// 2) ضغط الملف - يستقبل ملف واحد
app.post("/compress", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, error: "لم يتم رفع ملف" });

  let outputPath = createTempPath("compressed");
  try {
    const bytes = fs.readFileSync(req.file.path);
    const pdfDoc = await PDFDocument.load(bytes);
    const compressedBytes = await pdfDoc.save({ useObjectStreams: true });
    
    fs.writeFileSync(outputPath, compressedBytes);
    sendPdfAndCleanup(res, outputPath, "compressed.pdf", [req.file.path]);
  } catch (err) {
    safeDelete(req.file.path);
    res.status(500).json({ ok: false, error: "فشل ضغط الملف" });
  }
});

// 3) استخراج النص
app.post("/extract-text", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, error: "لم يتم رفع ملف" });

  try {
    const dataBuffer = fs.readFileSync(req.file.path);
    const data = await pdfParse(dataBuffer);
    
    safeDelete(req.file.path);
    res.json({ ok: true, text: data.text, pages: data.numpages });
  } catch (err) {
    safeDelete(req.file.path);
    res.status(500).json({ ok: false, error: "فشل استخراج النص" });
  }
});

// ====== Start Server ======
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT} (Standalone Mode)`);
});

export default app;
