import express from "express";
import axios from "axios";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import fs from "fs";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";
import pdfParse from "pdf-parse";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "200mb" }));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MAX_SIZE_BYTES = 150 * 1024 * 1024; // 150MB

// لو حبيت تستخدم بيانات Supabase هنا في المستقبل
const SUPABASE_URL = "https://tdqewqarcvdunwuxgios.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRkcWV3cWFyY3ZkdW53dXhnaW9zIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjU0ODc4NDcsImV4cCI6MjA4MTA2Mzg0N30.RSMghTLwda7kLidTohBFLqE7qCQoHs3S6l88ewUidRw";
const BUCKET_NAME = "pdf-files";

// ====== Helpers ======

function createTempFile(prefix = "pdf") {
  const random = Math.random().toString(36).substring(2, 10);
  return path.join(os.tmpdir(), `${prefix}-${Date.now()}-${random}.pdf`);
}

function safeDelete(filePath) {
  if (!filePath) return;
  fs.unlink(filePath, () => {});
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
      extractText: "/extract-text",
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

    const bytes = fs.readFileSync(source);
    const pdfDoc = await PDFDocument.load(bytes);

    const compressedBytes = await pdfDoc.save({ useObjectStreams: true });

    output = createTempFile("compressed");
    fs.writeFileSync(output, compressedBytes);

    const compressedSize = fs.statSync(output).size;

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
    safeDelete(source);
    safeDelete(output);

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

      const bytes = fs.readFileSync(filePath);
      const pdf = await PDFDocument.load(bytes);
      const copied = await mergeDoc.copyPages(
        pdf,
        Array.from({ length: pdf.getPageCount() }, (_, i) => i)
      );
      copied.forEach((p) => mergeDoc.addPage(p));
    }

    const mergedBytes = await mergeDoc.save();
    mergedPath = createTempFile("merged");
    fs.writeFileSync(mergedPath, mergedBytes);

    sendPdfFile(res, mergedPath, "merged.pdf", [...tempFiles, mergedPath]);
  } catch (err) {
    console.error("Error in /merge:", err);
    tempFiles.forEach(safeDelete);
    safeDelete(mergedPath);

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

    const bytes = fs.readFileSync(source);
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
    fs.writeFileSync(output, newBytes);

    sendPdfFile(res, output, "extracted-pages.pdf", [source, output]);
  } catch (err) {
    console.error("Error in /extract-pages:", err);
    safeDelete(source);
    safeDelete(output);

    if (!res.headersSent) {
      res.status(500).json({
        ok: false,
        error: err.message || "Internal error",
      });
    }
  }
});

// ====== 4) Extract text: /extract-text ======

app.post("/extract-text", async (req, res) => {
  let source = null;
  try {
    const { publicUrl } = req.body;
    if (!publicUrl) {
      return res
        .status(400)
        .json({ ok: false, error: "publicUrl is required" });
    }

    source = await downloadToTempFile(publicUrl);
    await ensureSizeLimit(source);

    const dataBuffer = fs.readFileSync(source);
    const data = await pdfParse(dataBuffer);

    res.status(200).json({
      ok: true,
      text: data.text || "",
      info: data.info || {},
      numpages: data.numpages || 0,
    });

    safeDelete(source);
  } catch (err) {
    console.error("Error in /extract-text:", err);
    safeDelete(source);
    if (!res.headersSent) {
      res.status(500).json({
        ok: false,
        error: err.message || "Internal error",
      });
    }
  }
});

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

    const bytes = fs.readFileSync(source);
    const pdf = await PDFDocument.load(bytes);

    const pageCount = pdf.getPageCount();

    res.status(200).json({
      ok: true,
      pages: pageCount,
      sizeBytes: size,
      sizeMB: (size / (1024 * 1024)).toFixed(2),
    });

    safeDelete(source);
  } catch (err) {
    console.error("Error in /info:", err);
    safeDelete(source);
    if (!res.headersSent) {
      res.status(500).json({
        ok: false,
        error: err.message || "Internal error",
      });
    }
  }
});

// ====== 6) Protect PDF with password: /protect ======
// NOTE: pdf-lib doesn't natively support encryption/password.
// في Vercel مفيش مكتبة native جاهزة.
// هنا هنعمل "حماية منطقية" عن طريق إضافة صفحة تحذير + metadata.
// ده جاهز ليوم ما ننقل للسيرفر اللي فيه مكتبة تشفير حقيقية.

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

    const bytes = fs.readFileSync(source);
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
    fs.writeFileSync(output, newBytes);

    sendPdfFile(res, output, "protected.pdf", [source, output]);
  } catch (err) {
    console.error("Error in /protect:", err);
    safeDelete(source);
    safeDelete(output);
    if (!res.headersSent) {
      res.status(500).json({
        ok: false,
        error: err.message || "Internal error",
      });
    }
  }
});

// ====== 7) Unlock PDF: /unlock ======
// هنا بنشيل صفحة التحذير لو موجودة وننضف الـ metadata

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

    const bytes = fs.readFileSync(source);
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
    fs.writeFileSync(output, newBytes);

    sendPdfFile(res, output, "unlocked.pdf", [source, output]);
  } catch (err) {
    console.error("Error in /unlock:", err);
    safeDelete(source);
    safeDelete(output);
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

    const bytes = fs.readFileSync(source);
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
    fs.writeFileSync(output, newBytes);

    sendPdfFile(res, output, "watermarked.pdf", [source, output]);
  } catch (err) {
    console.error("Error in /watermark-text:", err);
    safeDelete(source);
    safeDelete(output);
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

    const bytes = fs.readFileSync(source);
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
    fs.writeFileSync(output, newBytes);

    sendPdfFile(res, output, "rotated.pdf", [source, output]);
  } catch (err) {
    console.error("Error in /rotate-pages:", err);
    safeDelete(source);
    safeDelete(output);
    if (!res.headersSent) {
      res.status(500).json({
        ok: false,
        error: err.message || "Internal error",
      });
    }
  }
});

// ====== 10) Reorder pages: /reorder-pages ======
// المدخل: { publicUrl, order }
// مثال: order = [3,1,2] → الصفحة 3 تبقى الأولى، 1 تبقى الثانية...

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

    const bytes = fs.readFileSync(source);
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
    fs.writeFileSync(output, newBytes);

    sendPdfFile(res, output, "reordered.pdf", [source, output]);
  } catch (err) {
    console.error("Error in /reorder-pages:", err);
    safeDelete(source);
    safeDelete(output);
    if (!res.headersSent) {
      res.status(500).json({
        ok: false,
        error: err.message || "Internal error",
      });
    }
  }
});

// ====== 11) Edit metadata: /metadata ======
// المدخل: { publicUrl, title?, author?, subject?, keywords? }

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

    const bytes = fs.readFileSync(source);
    const pdf = await PDFDocument.load(bytes);

    if (title) pdf.setTitle(title);
    if (author) pdf.setAuthor(author);
    if (subject) pdf.setSubject(subject);
    if (keywords) pdf.setKeywords(keywords);

    const newBytes = await pdf.save();
    output = createTempFile("metadata");
    fs.writeFileSync(output, newBytes);

    sendPdfFile(res, output, "metadata.pdf", [source, output]);
  } catch (err) {
    console.error("Error in /metadata:", err);
    safeDelete(source);
    safeDelete(output);
    if (!res.headersSent) {
      res.status(500).json({
        ok: false,
        error: err.message || "Internal error",
      });
    }
  }
});

// ====== Local run ======

app.listen(PORT, () => {
  console.log(`PDF Server PRO running on port ${PORT}`);
});
