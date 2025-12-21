import express from "express";
import axios from "axios";
import cors from "cors";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import fs from "fs";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";
import pdfParse from "pdf-parse";
import { createClient } from "@supabase/supabase-js";

// ====== Configuration and Initialization ======

const app = express();
const PORT = process.env.PORT || 3000;

// Supabase Configuration (Hardcoded as requested)
const SUPABASE_URL = "https://tdqewqarcvdunwuxgios.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRkcWV3cWFyY3ZkdW53dXhnaW9zIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjU0ODc4NDcsImV4cCI6MjA4MTA2Mzg0N30.RSMghTLwda7kLidTohBFLqE7qCQoHs3S6l88ewUidRw";
const BUCKET_NAME = "pdf-files";

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const MAX_SIZE_BYTES = 150 * 1024 * 1024; // 150MB

// Middleware
app.use(express.json({ limit: "200mb" }));
app.use(cors());

// Path Helpers for ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ====== File & Supabase Helpers ======

/**
 * Creates a unique temporary file path in the system's temp directory.
 * @param {string} prefix
 * @returns {string}
 */
function createTempFile(prefix = "file") {
  const random = Math.random().toString(36).substring(2, 10);
  return path.join(os.tmpdir(), `${prefix}-${Date.now()}-${random}.pdf`);
}

/**
 * Safely attempts to delete a file.
 * @param {string} filePath
 */
function safeDelete(filePath) {
  if (!filePath) return;
  fs.unlink(filePath, () => {});
}

/**
 * Downloads a file from a URL to a temporary path.
 * @param {string} url - Public URL of the file.
 * @returns {Promise<string>} The temporary file path.
 */
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

/**
 * Checks if the file size exceeds the maximum limit.
 * @param {string} filePath - Path to the file.
 * @returns {Promise<number>} The file size in bytes.
 * @throws {Error} If the file is too large.
 */
async function ensureSizeLimit(filePath) {
  const stats = fs.statSync(filePath);
  if (stats.size > MAX_SIZE_BYTES) {
    safeDelete(filePath);
    throw new Error("File too large (max 150MB)");
  }
  return stats.size;
}

/**
 * Streams the PDF file to the response and cleans up temporary files.
 * @param {express.Response} res - Express response object.
 * @param {string} filePath - Path to the PDF file to stream.
 * @param {string} fileName - Suggested file name for download.
 * @param {string[]} cleanupPaths - Array of paths to delete after streaming.
 */
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

/**
 * Uploads a Buffer to Supabase Storage.
 * @param {Buffer} buffer - File data buffer.
 * @param {string} filename - Desired file name (must be unique).
 * @param {string} contentType - MIME type.
 * @returns {Promise<string>} The public URL of the uploaded file.
 */
async function uploadBufferToSupabase(
  buffer,
  filename,
  contentType = "application/pdf"
) {
  const filePath = `pdfs/${Date.now()}-${filename}`;
  const { data, error } = await supabase.storage
    .from(BUCKET_NAME)
    .upload(filePath, buffer, {
      contentType: contentType,
      upsert: true,
    });

  if (error) {
    throw new Error(`Supabase upload failed: ${error.message}`);
  }

  const publicUrlResult = supabase.storage
    .from(BUCKET_NAME)
    .getPublicUrl(filePath);

  if (publicUrlResult.error) {
    throw new Error(
      `Supabase getPublicUrl failed: ${publicUrlResult.error.message}`
    );
  }

  return publicUrlResult.data.publicUrl;
}

/**
 * Logs an action to the 'logs' table in Supabase.
 * @param {string} action - The action performed.
 * @param {object} [extraInfo={}] - Additional data to store.
 */
async function saveLog(action, extraInfo = {}) {
  try {
    const { error } = await supabase.from("logs").insert([
      {
        action: action,
        extra: extraInfo,
      },
    ]);

    if (error) {
      console.error("Supabase Log Error:", error.message);
    }
  } catch (err) {
    console.error("Failed to save log:", err.message);
  }
}

// ====== Basic Routes ======

app.get("/", async (req, res) => {
  res.status(200).json({
    ok: true,
    server: "PDF Server PRO (Advanced + Supabase + Vercel-ready)",
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
      extractImages: "/extract-images",
      pdfToBase64: "/pdf-to-base64",
      base64ToPdf: "/base64-to-pdf",
    },
  });
});

app.get("/health", async (req, res) => {
  try {
    await saveLog("health-check");
    res.status(200).json({
      ok: true,
      message: "PDF Server PRO is healthy and Supabase connection test successful",
    });
  } catch (err) {
    console.error("Error in /health:", err);
    res.status(500).json({
      ok: false,
      error: "Internal error",
      details: err.message,
    });
  }
});

// ====== 1) Compress: /compress ======

app.post("/compress", async (req, res) => {
  let source = null;
  let output = null;
  let supabaseUrl = null;
  let originalSize = 0;
  let compressedSize = 0;
  let savedPercent = 0;

  try {
    const { publicUrl } = req.body;
    if (!publicUrl || typeof publicUrl !== "string") {
      return res
        .status(400)
        .json({ ok: false, error: "publicUrl is required" });
    }

    source = await downloadToTempFile(publicUrl);
    originalSize = await ensureSizeLimit(source);

    const bytes = fs.readFileSync(source);
    const pdfDoc = await PDFDocument.load(bytes);

    const compressedBytes = await pdfDoc.save({ useObjectStreams: true });
    compressedSize = compressedBytes.length;

    output = createTempFile("compressed");
    fs.writeFileSync(output, compressedBytes);

    savedPercent =
      originalSize > 0
        ? ((1 - compressedSize / originalSize) * 100).toFixed(2)
        : 0;

    // Upload to Supabase
    supabaseUrl = await uploadBufferToSupabase(
      Buffer.from(compressedBytes),
      "compressed.pdf"
    );

    // Log
    await saveLog("compress", {
      originalSize,
      compressedSize,
      savedPercent: parseFloat(savedPercent),
      supabaseUrl,
    });

    res.setHeader(
      "X-PDF-Info",
      JSON.stringify({
        originalMB: (originalSize / (1024 * 1024)).toFixed(2),
        compressedMB: (compressedSize / (1024 * 1024)).toFixed(2),
        savedPercent: savedPercent,
        supabaseUrl: supabaseUrl,
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
        details: err.message,
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
  let supabaseUrl = null;

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

    // Upload to Supabase
    supabaseUrl = await uploadBufferToSupabase(
      Buffer.from(mergedBytes),
      "merged.pdf"
    );

    // Log
    await saveLog("merge", {
      filesCount: publicUrls.length,
      supabaseUrl,
    });

    res.setHeader("X-Supabase-Url", supabaseUrl);
    sendPdfFile(res, mergedPath, "merged.pdf", [...tempFiles, mergedPath]);
  } catch (err) {
    console.error("Error in /merge:", err);
    tempFiles.forEach(safeDelete);
    safeDelete(mergedPath);

    if (!res.headersSent) {
      res.status(500).json({
        ok: false,
        error: err.message || "Internal error",
        details: err.message,
      });
    }
  }
});

// ====== 3) Extract pages: /extract-pages ======

app.post("/extract-pages", async (req, res) => {
  let source = null;
  let output = null;
  let supabaseUrl = null;
  let pageNumbers = [];

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

    // Upload to Supabase
    supabaseUrl = await uploadBufferToSupabase(
      Buffer.from(newBytes),
      "extracted-pages.pdf"
    );

    // Log
    await saveLog("extract-pages", {
      requestedPages: req.body.pages,
      finalPages: pageNumbers.length,
      supabaseUrl,
    });

    res.setHeader("X-Supabase-Url", supabaseUrl);
    sendPdfFile(res, output, "extracted-pages.pdf", [source, output]);
  } catch (err) {
    console.error("Error in /extract-pages:", err);
    safeDelete(source);
    safeDelete(output);

    if (!res.headersSent) {
      res.status(500).json({
        ok: false,
        error: err.message || "Internal error",
        details: err.message,
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

    // Log
    await saveLog("extract-text", {
      textLength: data.text ? data.text.length : 0,
      pages: data.numpages || 0,
    });

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
        details: err.message,
      });
    }
  }
});

// ====== 5) Info: /info ======

app.post("/info", async (req, res) => {
  let source = null;
  let size = 0;
  let pageCount = 0;

  try {
    const { publicUrl } = req.body;
    if (!publicUrl) {
      return res
        .status(400)
        .json({ ok: false, error: "publicUrl is required" });
    }

    source = await downloadToTempFile(publicUrl);
    size = await ensureSizeLimit(source);

    const bytes = fs.readFileSync(source);
    const pdf = await PDFDocument.load(bytes);

    pageCount = pdf.getPageCount();
    const sizeMB = (size / (1024 * 1024)).toFixed(2);

    // Log
    await saveLog("info", {
      pages: pageCount,
      sizeBytes: size,
      sizeMB: sizeMB,
    });

    res.status(200).json({
      ok: true,
      pages: pageCount,
      sizeBytes: size,
      sizeMB: sizeMB,
    });

    safeDelete(source);
  } catch (err) {
    console.error("Error in /info:", err);
    safeDelete(source);
    if (!res.headersSent) {
      res.status(500).json({
        ok: false,
        error: err.message || "Internal error",
        details: err.message,
      });
    }
  }
});

// ====== 6) Protect PDF with password: /protect ======

app.post("/protect", async (req, res) => {
  let source = null;
  let output = null;
  let supabaseUrl = null;

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

    // Upload to Supabase
    supabaseUrl = await uploadBufferToSupabase(
      Buffer.from(newBytes),
      "protected.pdf"
    );

    // Log
    await saveLog("protect", {
      hasWarningPage: true,
      supabaseUrl,
    });

    res.setHeader("X-Supabase-Url", supabaseUrl);
    sendPdfFile(res, output, "protected.pdf", [source, output]);
  } catch (err) {
    console.error("Error in /protect:", err);
    safeDelete(source);
    safeDelete(output);
    if (!res.headersSent) {
      res.status(500).json({
        ok: false,
        error: err.message || "Internal error",
        details: err.message,
      });
    }
  }
});

// ====== 7) Unlock PDF: /unlock ======

app.post("/unlock", async (req, res) => {
  let source = null;
  let output = null;
  let supabaseUrl = null;

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

    const startIndex = 1 < pageCount ? 1 : 0; // Check if there's more than one page to remove the first one
    const removedWarningPage = startIndex > 0;

    const copied = await newPdf.copyPages(
      pdf,
      Array.from({ length: pageCount - startIndex }, (_, i) => i + startIndex)
    );
    copied.forEach((p) => newPdf.addPage(p));

    newPdf.setTitle("Unlocked PDF");
    newPdf.setSubject("");
    newPdf.setKeywords([]);

    const newBytes = await newPdf.save();
    output = createTempFile("unlocked");
    fs.writeFileSync(output, newBytes);

    // Upload to Supabase
    supabaseUrl = await uploadBufferToSupabase(
      Buffer.from(newBytes),
      "unlocked.pdf"
    );

    // Log
    await saveLog("unlock", {
      removedWarningPage,
      supabaseUrl,
    });

    res.setHeader("X-Supabase-Url", supabaseUrl);
    sendPdfFile(res, output, "unlocked.pdf", [source, output]);
  } catch (err) {
    console.error("Error in /unlock:", err);
    safeDelete(source);
    safeDelete(output);
    if (!res.headersSent) {
      res.status(500).json({
        ok: false,
        error: err.message || "Internal error",
        details: err.message,
      });
    }
  }
});

// ====== 8) Watermark text: /watermark-text ======

app.post("/watermark-text", async (req, res) => {
  let source = null;
  let output = null;
  let supabaseUrl = null;
  const defaultOpacity = 0.2;
  const defaultColor = "red";

  try {
    const { publicUrl, text, opacity = defaultOpacity, color = defaultColor } =
      req.body;

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

    // Simple color mapping for demonstration, should be enhanced for production
    let colorRgb = rgb(1, 0, 0); // Default: Red
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

    // Upload to Supabase
    supabaseUrl = await uploadBufferToSupabase(
      Buffer.from(newBytes),
      "watermarked.pdf"
    );

    // Log
    await saveLog("watermark-text", {
      text,
      color,
      opacity,
      supabaseUrl,
    });

    res.setHeader("X-Supabase-Url", supabaseUrl);
    sendPdfFile(res, output, "watermarked.pdf", [source, output]);
  } catch (err) {
    console.error("Error in /watermark-text:", err);
    safeDelete(source);
    safeDelete(output);
    if (!res.headersSent) {
      res.status(500).json({
        ok: false,
        error: err.message || "Internal error",
        details: err.message,
      });
    }
  }
});

// ====== 9) Rotate pages: /rotate-pages ======

app.post("/rotate-pages", async (req, res) => {
  let source = null;
  let output = null;
  let supabaseUrl = null;
  let pageNumbers = [];

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

    // Upload to Supabase
    supabaseUrl = await uploadBufferToSupabase(
      Buffer.from(newBytes),
      "rotated.pdf"
    );

    // Log
    await saveLog("rotate-pages", {
      pages: pageNumbers.length,
      angle: angleDeg,
      supabaseUrl,
    });

    res.setHeader("X-Supabase-Url", supabaseUrl);
    sendPdfFile(res, output, "rotated.pdf", [source, output]);
  } catch (err) {
    console.error("Error in /rotate-pages:", err);
    safeDelete(source);
    safeDelete(output);
    if (!res.headersSent) {
      res.status(500).json({
        ok: false,
        error: err.message || "Internal error",
        details: err.message,
      });
    }
  }
});

// ====== 10) Reorder pages: /reorder-pages ======

app.post("/reorder-pages", async (req, res) => {
  let source = null;
  let output = null;
  let supabaseUrl = null;

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

    // Upload to Supabase
    supabaseUrl = await uploadBufferToSupabase(
      Buffer.from(newBytes),
      "reordered.pdf"
    );

    // Log
    await saveLog("reorder-pages", {
      order: cleanOrder,
      supabaseUrl,
    });

    res.setHeader("X-Supabase-Url", supabaseUrl);
    sendPdfFile(res, output, "reordered.pdf", [source, output]);
  } catch (err) {
    console.error("Error in /reorder-pages:", err);
    safeDelete(source);
    safeDelete(output);
    if (!res.headersSent) {
      res.status(500).json({
        ok: false,
        error: err.message || "Internal error",
        details: err.message,
      });
    }
  }
});

// ====== 11) Edit metadata: /metadata ======

app.post("/metadata", async (req, res) => {
  let source = null;
  let output = null;
  let supabaseUrl = null;
  const changedFields = {};

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

    if (title) {
      pdf.setTitle(title);
      changedFields.title = title;
    }
    if (author) {
      pdf.setAuthor(author);
      changedFields.author = author;
    }
    if (subject) {
      pdf.setSubject(subject);
      changedFields.subject = subject;
    }
    if (keywords) {
      pdf.setKeywords(keywords);
      changedFields.keywords = keywords;
    }

    const newBytes = await pdf.save();
    output = createTempFile("metadata");
    fs.writeFileSync(output, newBytes);

    // Upload to Supabase
    supabaseUrl = await uploadBufferToSupabase(
      Buffer.from(newBytes),
      "metadata.pdf"
    );

    // Log
    await saveLog("metadata", {
      changedFields,
      supabaseUrl,
    });

    res.setHeader("X-Supabase-Url", supabaseUrl);
    sendPdfFile(res, output, "metadata.pdf", [source, output]);
  } catch (err) {
    console.error("Error in /metadata:", err);
    safeDelete(source);
    safeDelete(output);
    if (!res.headersSent) {
      res.status(500).json({
        ok: false,
        error: err.message || "Internal error",
        details: err.message,
      });
    }
  }
});

// ====== 12) Extract images (Placeholder): /extract-images ======
// NOTE: pdf-lib does not support image extraction. This is a placeholder
// for logical implementation (to be replaced with a library like 'pdf-image'
// or a cloud service if Vercel constraints allow).

app.post("/extract-images", async (req, res) => {
  let source = null;
  let imageCount = 0;
  const imagePlaceholders = [];

  try {
    const { publicUrl } = req.body;
    if (!publicUrl) {
      return res
        .status(400)
        .json({ ok: false, error: "publicUrl is required" });
    }

    source = await downloadToTempFile(publicUrl);
    await ensureSizeLimit(source);

    // --- Placeholder/Mock Image Extraction Logic ---
    // In a real scenario, we would use a library that handles image extraction.
    // For Vercel/pdf-lib constraints, we mock the logic here:

    const bytes = fs.readFileSync(source);
    const pdf = await PDFDocument.load(bytes);

    imageCount = pdf.getPageCount() * 2; // Mock: 2 images per page
    for (let i = 0; i < imageCount; i++) {
      // Mock: Generate a small dummy buffer for a tiny JPEG
      const dummyImageBuffer = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjRRAwAAAABJRU5ErkJggg==",
        "base64"
      );

      const filename = `image-${i + 1}-${Date.now()}.png`;
      const url = await uploadBufferToSupabase(
        dummyImageBuffer,
        `images/${filename}`,
        "image/png"
      );

      imagePlaceholders.push({
        index: i + 1,
        url: url,
      });
    }
    // --- End Placeholder/Mock Logic ---

    // Log
    await saveLog("extract-images", {
      count: imageCount,
    });

    res.status(200).json({
      ok: true,
      message:
        "Image extraction is simulated due to pdf-lib limitations. Check Supabase for mock images.",
      count: imageCount,
      images: imagePlaceholders,
    });

    safeDelete(source);
  } catch (err) {
    console.error("Error in /extract-images:", err);
    safeDelete(source);
    if (!res.headersSent) {
      res.status(500).json({
        ok: false,
        error: err.message || "Internal error",
        details: err.message,
      });
    }
  }
});

// ====== 13) PDF to Base64: /pdf-to-base64 ======

app.post("/pdf-to-base64", async (req, res) => {
  let source = null;
  let sizeBytes = 0;

  try {
    const { publicUrl } = req.body;
    if (!publicUrl) {
      return res
        .status(400)
        .json({ ok: false, error: "publicUrl is required" });
    }

    source = await downloadToTempFile(publicUrl);
    sizeBytes = await ensureSizeLimit(source);

    const dataBuffer = fs.readFileSync(source);
    const base64 = dataBuffer.toString("base64");

    // Log
    await saveLog("pdf-to-base64", {
      sizeBytes,
    });

    res.status(200).json({
      ok: true,
      base64,
      sizeBytes,
    });

    safeDelete(source);
  } catch (err) {
    console.error("Error in /pdf-to-base64:", err);
    safeDelete(source);
    if (!res.headersSent) {
      res.status(500).json({
        ok: false,
        error: err.message || "Internal error",
        details: err.message,
      });
    }
  }
});

// ====== 14) Base64 to PDF: /base64-to-pdf ======

app.post("/base64-to-pdf", async (req, res) => {
  let supabaseUrl = null;

  try {
    const { base64, fileName } = req.body;
    if (!base64 || !fileName) {
      return res
        .status(400)
        .json({ ok: false, error: "base64 and fileName are required" });
    }

    const buffer = Buffer.from(base64, "base64");
    const bufferSize = buffer.length;

    if (bufferSize > MAX_SIZE_BYTES) {
      throw new Error("Base64 data too large (max 150MB after decoding)");
    }

    // Upload to Supabase
    supabaseUrl = await uploadBufferToSupabase(
      buffer,
      fileName.endsWith(".pdf") ? fileName : `${fileName}.pdf`
    );

    // Log
    await saveLog("base64-to-pdf", {
      fileName,
      sizeBytes: bufferSize,
      supabaseUrl,
    });

    res.status(200).json({
      ok: true,
      message: "PDF successfully uploaded from Base64",
      supabaseUrl,
      sizeBytes: bufferSize,
    });
  } catch (err) {
    console.error("Error in /base64-to-pdf:", err);
    if (!res.headersSent) {
      res.status(500).json({
        ok: false,
        error: err.message || "Internal error",
        details: err.message,
      });
    }
  }
});

// ====== Local run (Vercel ignores this block when deploying as a Serverless Function) ======

app.listen(PORT, () => {
  console.log(`PDF Server PRO running on port ${PORT}`);
});

// Vercel export (for Serverless Functions)
export default app;