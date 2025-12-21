import express from "express";
import axios from "axios";
import cors from "cors";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import fs from "fs";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";
import pdfParse from "pdf-parse";

// ====== Configuration and Initialization ======

const app = express();
const PORT = process.env.PORT || 3000;

const MAX_SIZE_BYTES = 150 * 1024 * 1024; // 150MB

// Middleware
app.use(express.json({ limit: "200mb" }));
app.use(cors());

// Path Helpers for ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ====== File Helpers ======

function createTempFile(prefix = "file") {
  const random = Math.random().toString(36).substring(2, 10);
  return path.join(os.tmpdir(), `${prefix}-${Date.now()}-${random}.pdf`);
}

function safeDelete(filePath) {
  if (!filePath) return;
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (err) {
    console.error("Error deleting temp file:", err);
  }
}

async function downloadToTempFile(url) {
  const tempPath = createTempFile("source");
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
      if (!error) resolve(tempPath);
    });
  });
}

async function ensureSizeLimit(filePath) {
  const stats = fs.statSync(filePath);
  if (stats.size > MAX_SIZE_BYTES) {
    safeDelete(filePath);
    throw new Error("File too large (max 150MB)");
  }
  return stats.size;
}

function sendPdfFile(res, filePath, fileName, cleanupPaths = []) {
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${fileName || "file.pdf"}"`
  );

  const stream = fs.createReadStream(filePath);
  stream.pipe(res);

  stream.on("close", () => {
    cleanupPaths.forEach(safeDelete);
  });

  stream.on("error", (err) => {
    console.error("Error streaming PDF:", err);
    cleanupPaths.forEach(safeDelete);
    if (!res.headersSent) {
      res.status(500).json({ ok: false, error: "Error streaming PDF" });
    }
  });
}

// دالة لوج وهمية بديلة لـ Supabase
async function saveLog(action, extraInfo = {}) {
  console.log(`[LOG] Action: ${action}`, extraInfo);
}

// ====== Routes ======

app.get("/", (req, res) => {
  res.status(200).json({
    ok: true,
    server: "PDF Server PRO (Standalone - No DB)",
    status: "running"
  });
});

app.get("/health", async (req, res) => {
  await saveLog("health-check");
  res.status(200).json({ ok: true, message: "Server is healthy" });
});

// مثال معدل: /compress
app.post("/compress", async (req, res) => {
  let source = null;
  let output = null;
  try {
    const { publicUrl } = req.body;
    if (!publicUrl) return res.status(400).json({ ok: false, error: "publicUrl is required" });

    source = await downloadToTempFile(publicUrl);
    const originalSize = await ensureSizeLimit(source);

    const bytes = fs.readFileSync(source);
    const pdfDoc = await PDFDocument.load(bytes);
    const compressedBytes = await pdfDoc.save({ useObjectStreams: true });

    output = createTempFile("compressed");
    fs.writeFileSync(output, compressedBytes);

    await saveLog("compress", { originalSize, compressedSize: compressedBytes.length });

    sendPdfFile(res, output, "compressed.pdf", [source, output]);
  } catch (err) {
    console.error(err);
    safeDelete(source);
    safeDelete(output);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// مثال معدل: /merge
app.post("/merge", async (req, res) => {
  const { publicUrls } = req.body;
  if (!Array.isArray(publicUrls) || publicUrls.length < 2) {
    return res.status(400).json({ ok: false, error: "At least 2 URLs required" });
  }

  const tempFiles = [];
  let mergedPath = null;
  try {
    const mergeDoc = await PDFDocument.create();
    for (const url of publicUrls) {
      const filePath = await downloadToTempFile(url);
      tempFiles.push(filePath);
      await ensureSizeLimit(filePath);
      const pdf = await PDFDocument.load(fs.readFileSync(filePath));
      const copied = await mergeDoc.copyPages(pdf, pdf.getPageIndices());
      copied.forEach((p) => mergeDoc.addPage(p));
    }

    const mergedBytes = await mergeDoc.save();
    mergedPath = createTempFile("merged");
    fs.writeFileSync(mergedPath, mergedBytes);

    await saveLog("merge", { filesCount: publicUrls.length });
    sendPdfFile(res, mergedPath, "merged.pdf", [...tempFiles, mergedPath]);
  } catch (err) {
    tempFiles.forEach(safeDelete);
    safeDelete(mergedPath);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ملاحظة: يمكنك تطبيق نفس المنطق (إزالة الرفع لـ Supabase وإرسال الملف مباشرة) على بقية الـ Endpoints بنفس الطريقة.

app.listen(PORT, () => {
  console.log(`PDF Server Standalone running on port ${PORT}`);
});

export default app;
