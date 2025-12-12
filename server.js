import express from "express";
import cors from "cors"; 
import axios from "axios";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
// 💡 استيراد الدوال غير المتزامنة (promises) والدوال المتزامنة/Streams معاً
import fs from "fs/promises"; 
import fs_sync from "fs"; 
import path from "path";
import os from "os";
import { fileURLToPath } from "url";
// تم إزالة استيراد pdfParse لتجنب انهيار Vercel (خطأ 500)

const app = express();
const PORT = process.env.PORT || 3000;

// 💡 حل مشكلة CORS: السماح لجميع النطاقات بالاتصال
app.use(cors());

// تحديد حجم الحمولة القصوى
app.use(express.json({ limit: "200mb" }));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MAX_SIZE_BYTES = 150 * 1024 * 1024; // 150MB

// ====== Helpers ======

function createTempFile(prefix = "pdf") {
  const random = Math.random().toString(36).substring(2, 10);
  return path.join(os.tmpdir(), `${prefix}-${Date.now()}-${random}.pdf`);
}

async function safeDelete(filePath) {
  if (!filePath) return;
  try {
    await fs.unlink(filePath);
  } catch (e) {
    // تجاهل أخطاء عدم وجود الملف
  }
}

// 💡 تعديل لاستخدام fs_sync.createWriteStream
async function downloadToTempFile(url) {
  const tempPath = createTempFile("source");
  const response = await axios({
    method: "GET",
    url,
    responseType: "stream",
  });

  return new Promise((resolve, reject) => {
    const writer = fs_sync.createWriteStream(tempPath);
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
  const stats = await fs.stat(filePath);
  if (stats.size > MAX_SIZE_BYTES) {
    await safeDelete(filePath);
    throw new Error("File too large (max 150MB)");
  }
  return stats.size;
}

// 💡 تعديل لاستخدام fs_sync.createReadStream
function sendPdfFile(res, filePath, fileName, cleanupPaths = []) {
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${fileName || "file.pdf"}"`
  );

  const stream = fs_sync.createReadStream(filePath);
  stream.pipe(res);

  stream.on("close", async () => {
    for (const p of cleanupPaths) await safeDelete(p);
  });

  stream.on("error", async (err) => {
    console.error("Error streaming PDF:", err);
    for (const p of cleanupPaths) await safeDelete(p);
    if (!res.headersSent) {
      res.status(500).json({
        ok: false,
        error: "Error streaming PDF",
      });
    }
  });
}

// ====== Basic routes ======

app.get("/", (req, res) => {
  res.status(200).json({
    ok: true,
    server: "PDF Server PRO (Vercel-ready)",
    status: "running",
    endpoints: {
      health: "/health",
      compress: "/compress",
      merge: "/merge",
      extractPages: "/extract-pages",
      // extractText: "/extract-text", // تم إزالتها مؤقتاً
      info: "/info",
      protect: "/protect",
      unlock: "/unlock",
      watermarkText: "/watermark-text",
      rotatePages: "/rotate-pages",
      reorderPages: "/reorder-pages",
      metadata: "/metadata",
    },
  });
});

app.get("/health", (req, res) => {
  res.status(200).json({
    ok: true,
    message: "PDF Server PRO is healthy",
  });
});

// ====== 1) Compress: /compress ======

app.post("/compress", async (req, res) => {
  let source = null;
  let output = null;

  try {
    const { publicUrl } = req.body;
    if (!publicUrl || typeof publicUrl !== "string") {
      return res
        .status(400)
        .json({ ok: false, error: "publicUrl is required" });
    }

    source = await downloadToTempFile(publicUrl);
    const originalSize = await ensureSizeLimit(source);

    const bytes = await fs.readFile(source);
    const pdfDoc = await PDFDocument.load(bytes);

    const compressedBytes = await pdfDoc.save({ useObjectStreams: true });

    output = createTempFile("compressed");
    await fs.writeFile(output, compressedBytes);

    const compressedSize = (await fs.stat(output)).size;

    res.setHeader(
      "X-PDF-Info",
      JSON.stringify({
        originalMB: (originalSize / (1024 * 1024)).toFixed(2),
        compressedMB: (compressedSize / (1024 * 1024)).toFixed(2),
        savedPercent:
          originalSize > 0
            ? ((1 - compressedSize / originalSize) * 100).toFixed(2)
            : 0,
      })
    );

    sendPdfFile(res, output, "compressed.pdf", [source, output]);
  } catch (err) {
    console.error("Error in /compress:", err);
    await safeDelete(source);
    await safeDelete(output);

    if (!res.headersSent) {
      const status =
        err.message && err.message.includes("File too large") ? 413 : 500;
      res.status(status).json({
        ok: false,
        error: err.message || "Internal error",
      });
    }
  }
});

// ====== 2) Merge: /merge ======

app.post("/merge", async (req, res) => {
  const { publicUrls } = req.body;

  if (!Array.isArray(publicUrls) || publicUrls.length < 2) {
    return res.status(400).json({
      ok: false,
      error: "publicUrls must be an array with at least 2 URLs",
    });
  }

  const tempFiles = [];
  let mergedPath = null;

  try {
    const mergeDoc = await PDFDocument.create();

    for (const url of publicUrls) {
      const filePath = await downloadToTempFile(url);
      tempFiles.push(filePath);
      await ensureSizeLimit(filePath);

      const bytes = await fs.readFile(filePath);
      const pdf = await PDFDocument.load(bytes);
      const copied = await mergeDoc.copyPages(
        pdf,
        Array.from({ length: pdf.getPageCount() }, (_, i) => i)
      );
      copied.forEach((p) => mergeDoc.addPage(p));
    }

    const mergedBytes = await mergeDoc.save();
    mergedPath = createTempFile("merged");
    await fs.writeFile(mergedPath, mergedBytes);

    sendPdfFile(res, mergedPath, "merged.pdf", [...tempFiles, mergedPath]);
  } catch (err) {
    console.error("Error in /merge:", err);
    for (const p of tempFiles) await safeDelete(p);
    await safeDelete(mergedPath);

    if (!res.headersSent) {
      res.status(500).json({
        ok: false,
        error: err.message || "Internal error",
      });
    }
  }
});

// ====== 3) Extract pages: /extract-pages ======

app.post("/extract-pages", async (req, res) => {
  let source = null;
  let output = null;

  try {
    const { publicUrl, pages } = req.body;

    if (!publicUrl || !pages) {
      return res.status(400).json({
        ok: false,
        error: "publicUrl and pages are required",
      });
    }

    source = await downloadToTempFile(publicUrl);
    await ensureSizeLimit(source);

    const bytes = await fs.readFile(source);
    const srcPdf = await PDFDocument.load(bytes);

    const targetPdf = await PDFDocument.create();

    let pageNumbers = [];

    if (Array.isArray(pages)) {
      pageNumbers = pages.map((p) => parseInt(p, 10));
    } else if (typeof pages === "string") {
      const parts = pages.split(",");
      for (const part of parts) {
        if (part.includes("-")) {
          const [start, end] = part.split("-").map((n) => parseInt(n, 10));
          for (let i = start; i <= end; i++) pageNumbers.push(i);
        } else {
          pageNumbers.push(parseInt(part, 10));
        }
      }
    }

    pageNumbers = pageNumbers.filter(
      (p) => !isNaN(p) && p >= 1 && p <= srcPdf.getPageCount()
    );

    if (pageNumbers.length === 0) {
      throw new Error("No valid pages specified");
    }

    const copied = await targetPdf.copyPages(
      srcPdf,
      pageNumbers.map((p) => p - 1)
    );
    copied.forEach((p) => targetPdf.addPage(p));

    const newBytes = await targetPdf.save();
    output = createTempFile("pages");
    await fs.writeFile(output, newBytes);

    sendPdfFile(res, output, "extracted-pages.pdf", [source, output]);
  } catch (err) {
    console.error("Error in /extract-pages:", err);
    await safeDelete(source);
    await safeDelete(output);

    if (!res.headersSent) {
      res.status(500).json({
        ok: false,
        error: err.message || "Internal error",
      });
    }
  }
});

// ====== 4) Extract text: /extract-text (REMOVED) ======

// ====== 5) Info: /info ======

app.post("/info", async (req, res) => {
  let source = null;
  try {
    const { publicUrl } = req.body;
    if (!publicUrl) {
      return res
        .status(400)
        .json({ ok: false, error: "publicUrl is required" });
    }

    source = await downloadToTempFile(publicUrl);
    const size = await ensureSizeLimit(source);

    const bytes = await fs.readFile(source);
    const pdf = await PDFDocument.load(bytes);

    const pageCount = pdf.getPageCount();

    const title = pdf.getTitle() || 'N/A';
    const author = pdf.getAuthor() || 'N/A';

    res.status(200).json({
      ok: true,
      pages: pageCount,
      sizeBytes: size,
      sizeMB: (size / (1024 * 1024)).toFixed(2),
      metadata: { title, author }
    });

    await safeDelete(source);
  } catch (err) {
    console.error("Error in /info:", err);
    await safeDelete(source);
    if (!res.headersSent) {
      res.status(500).json({
        ok: false,
        error: err.message || "Internal error",
      });
    }
  }
});

// ====== 6) Protect PDF with password: /protect ======

app.post("/protect", async (req, res) => {
  let source = null;
  let output = null;
  try {
    const { publicUrl, password } = req.body;
    if (!publicUrl || !password) {
      return res.status(400).json({
        ok: false,
        error: "publicUrl and password are required",
      });
    }

    source = await downloadToTempFile(publicUrl);
    await ensureSizeLimit(source);

    const bytes = await fs.readFile(source);
    const pdf = await PDFDocument.load(bytes);

    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const warningPage = pdf.addPage();
    const { width, height } = warningPage.getSize();

    const text = `This PDF is logically protected with password: ${password}.
True encryption is not applied (Vercel limitation).`;

    warningPage.drawText(text, {
      x: 50,
      y: height / 2,
      size: 14,
      font,
      color: rgb(1, 0, 0),
    });

    pdf.setTitle("Protected (logical) PDF");
    pdf.setSubject("Password: " + password);

    const newBytes = await pdf.save();
    output = createTempFile("protected");
    await fs.writeFile(output, newBytes);

    sendPdfFile(res, output, "protected.pdf", [source, output]);
  } catch (err) {
    console.error("Error in /protect:", err);
    await safeDelete(source);
    await safeDelete(output);
    if (!res.headersSent) {
      res.status(500).json({
        ok: false,
        error: err.message || "Internal error",
      });
    }
  }
});

// ====== 7) Unlock PDF: /unlock ======

app.post("/unlock", async (req, res) => {
  let source = null;
  let output = null;
  try {
    const { publicUrl } = req.body;
    if (!publicUrl) {
      return res
        .status(400)
        .json({ ok: false, error: "publicUrl is required" });
    }

    source = await downloadToTempFile(publicUrl);
    await ensureSizeLimit(source);

    const bytes = await fs.readFile(source);
    const pdf = await PDFDocument.load(bytes);

    const pageCount = pdf.getPageCount();
    const newPdf = await PDFDocument.create();

    const startIndex = 1 < pageCount ? 1 : 0;
    const copied = await newPdf.copyPages(
      pdf,
      Array.from({ length: pageCount - startIndex }, (_, i) => i + startIndex)
    );
    copied.forEach((p) => newPdf.addPage(p));

    newPdf.setTitle("Unlocked PDF");

    const newBytes = await newPdf.save();
    output = createTempFile("unlocked");
    await fs.writeFile(output, newBytes);

    sendPdfFile(res, output, "unlocked.pdf", [source, output]);
  } catch (err) {
    console.error("Error in /unlock:", err);
    await safeDelete(source);
    await safeDelete(output);
    if (!res.headersSent) {
      res.status(500).json({
        ok: false,
        error: err.message || "Internal error",
      });
    }
  }
});

// ====== 8) Watermark text: /watermark-text ======

app.post("/watermark-text", async (req, res) => {
  let source = null;
  let output = null;
  try {
    const { publicUrl, text, opacity = 0.2, color = "red" } = req.body;

    if (!publicUrl || !text) {
      return res.status(400).json({
        ok: false,
        error: "publicUrl and text are required",
      });
    }

    source = await downloadToTempFile(publicUrl);
    await ensureSizeLimit(source);

    const bytes = await fs.readFile(source);
    const pdf = await PDFDocument.load(bytes);

    const font = await pdf.embedFont(StandardFonts.HelveticaBold);

    let colorRgb = rgb(1, 0, 0);
    if (color === "blue") colorRgb = rgb(0, 0, 1);
    if (color === "green") colorRgb = rgb(0, 1, 0);
    if (color === "white") colorRgb = rgb(1, 1, 1);
    if (color === "black") colorRgb = rgb(0, 0, 0);

    const pages = pdf.getPages();
    for (const page of pages) {
      const { width, height } = page.getSize();
      page.drawText(text, {
        x: width / 4,
        y: height / 2,
        size: 30,
        font,
        color: colorRgb,
        opacity: opacity,
        rotate: { type: "degrees", angle: 45 },
      });
    }

    const newBytes = await pdf.save();
    output = createTempFile("watermark");
    await fs.writeFile(output, newBytes);

    sendPdfFile(res, output, "watermarked.pdf", [source, output]);
  } catch (err) {
    console.error("Error in /watermark-text:", err);
    await safeDelete(source);
    await safeDelete(output);
    if (!res.headersSent) {
      res.status(500).json({
        ok: false,
        error: err.message || "Internal error",
      });
    }
  }
});

// ====== 9) Rotate pages: /rotate-pages ======

app.post("/rotate-pages", async (req, res) => {
  let source = null;
  let output = null;
  try {
    const { publicUrl, pages, angle } = req.body;

    if (!publicUrl || !angle) {
      return res.status(400).json({
        ok: false,
        error: "publicUrl and angle are required",
      });
    }

    source = await downloadToTempFile(publicUrl);
    await ensureSizeLimit(source);

    const bytes = await fs.readFile(source);
    const pdf = await PDFDocument.load(bytes);

    const angleDeg = parseInt(angle, 10) || 0;

    let pageNumbers = [];
    if (!pages) {
      pageNumbers = Array.from({ length: pdf.getPageCount() }, (_, i) => i + 1);
    } else if (Array.isArray(pages)) {
      pageNumbers = pages.map((p) => parseInt(p, 10));
    } else if (typeof pages === "string") {
      const parts = pages.split(",");
      for (const part of parts) {
        if (part.includes("-")) {
          const [start, end] = part.split("-").map((n) => parseInt(n, 10));
          for (let i = start; i <= end; i++) pageNumbers.push(i);
        } else {
          pageNumbers.push(parseInt(part, 10));
        }
      }
    }

    pageNumbers = pageNumbers.filter(
      (p) => !isNaN(p) && p >= 1 && p <= pdf.getPageCount()
    );

    const allPages = pdf.getPages();
    pageNumbers.forEach((p) => {
      allPages[p - 1].setRotation({ type: "degrees", angle: angleDeg });
    });

    const newBytes = await pdf.save();
    output = createTempFile("rotated");
    await fs.writeFile(output, newBytes);

    sendPdfFile(res, output, "rotated.pdf", [source, output]);
  } catch (err) {
    console.error("Error in /rotate-pages:", err);
    await safeDelete(source);
    await safeDelete(output);
    if (!res.headersSent) {
      res.status(500).json({
        ok: false,
        error: err.message || "Internal error",
      });
    }
  }
});

// ====== 10) Reorder pages: /reorder-pages ======

app.post("/reorder-pages", async (req, res) => {
  let source = null;
  let output = null;
  try {
    const { publicUrl, order } = req.body;

    if (!publicUrl || !Array.isArray(order) || order.length === 0) {
      return res.status(400).json({
        ok: false,
        error: "publicUrl and order (array) are required",
      });
    }

    source = await downloadToTempFile(publicUrl);
    await ensureSizeLimit(source);

    const bytes = await fs.readFile(source);
    const pdf = await PDFDocument.load(bytes);

    const pageCount = pdf.getPageCount();
    const newPdf = await PDFDocument.create();

    const cleanOrder = order
      .map((p) => parseInt(p, 10))
      .filter((p) => !isNaN(p) && p >= 1 && p <= pageCount);

    if (cleanOrder.length === 0) {
      throw new Error("No valid page order provided");
    }

    const copied = await newPdf.copyPages(
      pdf,
      cleanOrder.map((p) => p - 1)
    );
    copied.forEach((p) => newPdf.addPage(p));

    const newBytes = await newPdf.save();
    output = createTempFile("reordered");
    await fs.writeFile(output, newBytes);

    sendPdfFile(res, output, "reordered.pdf", [source, output]);
  } catch (err) {
    console.error("Error in /reorder-pages:", err);
    await safeDelete(source);
    await safeDelete(output);
    if (!res.headersSent) {
      res.status(500).json({
        ok: false,
        error: err.message || "Internal error",
      });
    }
  }
});

// ====== 11) Edit metadata: /metadata ======

app.post("/metadata", async (req, res) => {
  let source = null;
  let output = null;
  try {
    const { publicUrl, title, author, subject, keywords } = req.body;

    if (!publicUrl) {
      return res
        .status(400)
        .json({ ok: false, error: "publicUrl is required" });
    }

    source = await downloadToTempFile(publicUrl);
    await ensureSizeLimit(source);

    const bytes = await fs.readFile(source);
    const pdf = await PDFDocument.load(bytes);

    if (title) pdf.setTitle(title);
    if (author) pdf.setAuthor(author);
    if (subject) pdf.setSubject(subject);
    if (keywords) pdf.setKeywords(keywords);

    const newBytes = await pdf.save();
    output = createTempFile("metadata");
    await fs.writeFile(output, newBytes);

    sendPdfFile(res, output, "metadata.pdf", [source, output]);
  } catch (err) {
    console.error("Error in /metadata:", err);
    await safeDelete(source);
    await safeDelete(output);
    if (!res.headersSent) {
      res.status(500).json({
        ok: false,
        error: err.message || "Internal error",
      });
    }
  }
});

// ====== Local run (ignored by Vercel) ======

app.listen(PORT, () => {
  console.log(`PDF Server PRO running on port ${PORT}`);
});
