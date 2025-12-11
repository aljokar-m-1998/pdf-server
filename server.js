import express from "express";
import axios from "axios";
import { PDFDocument } from "pdf-lib";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import os from "os";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "200mb" }));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ✅ Route رئيسي — علشان السيرفر يظهر شغال
app.get("/", (req, res) => {
  res.status(200).json({
    ok: true,
    server: "PDF Compressor PRO",
    status: "running",
    endpoints: {
      health: "/health",
      compress: "/compress"
    }
  });
});

// ✅ Route اختبار
app.get("/health", (req, res) => {
  res.status(200).json({
    ok: true,
    message: "PDF Compressor PRO is healthy"
  });
});

// ✅ أدوات مساعدة
function createTempFile(prefix = "pdf") {
  const random = Math.random().toString(36).substring(2, 10);
  return path.join(os.tmpdir(), `${prefix}-${Date.now()}-${random}.pdf`);
}

function safeDelete(filePath) {
  if (!filePath) return;
  fs.unlink(filePath, () => {});
}

// ✅ تنزيل PDF من URL
async function downloadPdf(url) {
  const tempPath = createTempFile("source");

  const response = await axios({
    method: "GET",
    url,
    responseType: "stream"
  });

  return new Promise((resolve, reject) => {
    const writer = fs.createWriteStream(tempPath);
    response.data.pipe(writer);

    writer.on("error", reject);
    writer.on("close", () => resolve(tempPath));
  });
}

// ✅ ضغط PDF (إعادة كتابة)
async function compressPdf(inputPath) {
  const outputPath = createTempFile("compressed");

  const bytes = fs.readFileSync(inputPath);
  const pdfDoc = await PDFDocument.load(bytes);

  const compressedBytes = await pdfDoc.save({ useObjectStreams: true });

  fs.writeFileSync(outputPath, compressedBytes);

  return outputPath;
}

// ✅ Route ضغط PDF
app.post("/compress", async (req, res) => {
  let source = null;
  let compressed = null;

  try {
    const { publicUrl } = req.body;

    if (!publicUrl) {
      return res.status(400).json({
        ok: false,
        error: "publicUrl is required"
      });
    }

    if (!publicUrl.toLowerCase().includes(".pdf")) {
      return res.status(400).json({
        ok: false,
        error: "URL does not appear to be a PDF"
      });
    }

    // ✅ تنزيل PDF
    source = await downloadPdf(publicUrl);

    const stats = fs.statSync(source);
    const maxSize = 150 * 1024 * 1024;

    if (stats.size > maxSize) {
      safeDelete(source);
      return res.status(413).json({
        ok: false,
        error: "File too large (max 150MB)"
      });
    }

    // ✅ ضغط PDF
    compressed = await compressPdf(source);

    const originalSize = stats.size;
    const compressedSize = fs.statSync(compressed).size;

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", "attachment; filename=compressed.pdf");

    const stream = fs.createReadStream(compressed);
    stream.pipe(res);

    stream.on("close", () => {
      safeDelete(source);
      safeDelete(compressed);
    });

  } catch (err) {
    console.error("Compression error:", err);

    safeDelete(source);
    safeDelete(compressed);

    if (!res.headersSent) {
      res.status(500).json({
        ok: false,
        error: "Internal server error",
        detail: err.message
      });
    }
  }
});

// ✅ تشغيل محلي
app.listen(PORT, () => {
  console.log(`PDF Compressor PRO running on port ${PORT}`);
});
