// server.js
// سيرفر واحد بـ Express فيه كل الـ Routes اللي محتاجها الواجهة

const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");

const pdfParse = require("pdf-parse");
const PDFMerger = require("pdf-merger-js");
const { PDFDocument, degrees } = require("pdf-lib");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json({ limit: "50mb" }));

// Helper لتحويل Base64 لـ Buffer
function decodeBase64Pdf(fileBase64) {
  try {
    return Buffer.from(fileBase64, "base64");
  } catch (e) {
    return null;
  }
}

// ============== اختبار رئيسي ==============
app.get("/", (req, res) => {
  res.send("PDF Master Tool Server is running");
});

// ============== 1) استخراج النص ==============
app.post("/extract-text", async (req, res) => {
  try {
    const { fileBase64 } = req.body || {};

    if (!fileBase64) {
      return res
        .status(400)
        .json({ ok: false, error: "No fileBase64 provided" });
    }

    const buffer = decodeBase64Pdf(fileBase64);
    if (!buffer) {
      return res.status(400).json({ ok: false, error: "Invalid base64" });
    }

    const result = await pdfParse(buffer);

    return res.status(200).json({
      ok: true,
      text: result.text || "",
    });
  } catch (err) {
    console.error("extract-text error:", err);
    return res
      .status(500)
      .json({ ok: false, error: "Failed to extract text" });
  }
});

// ============== 2) دمج PDF ==============
app.post("/merge", async (req, res) => {
  try {
    const { files } = req.body || {};

    if (!files || !Array.isArray(files) || files.length < 2) {
      return res
        .status(400)
        .json({ ok: false, error: "Provide at least two files" });
    }

    const merger = new PDFMerger();

    for (const fileBase64 of files) {
      const buffer = decodeBase64Pdf(fileBase64);
      if (!buffer) {
        return res.status(400).json({ ok: false, error: "Invalid base64" });
      }
      await merger.add(buffer);
    }

    const mergedBuffer = await merger.saveAsBuffer();

    return res.status(200).json({
      ok: true,
      fileBase64: mergedBuffer.toString("base64"),
    });
  } catch (err) {
    console.error("merge error:", err);
    return res.status(500).json({ ok: false, error: "Failed to merge PDFs" });
  }
});

// ============== 3) تقسيم PDF لصفحات منفصلة ==============
app.post("/split", async (req, res) => {
  try {
    const { fileBase64 } = req.body || {};

    if (!fileBase64) {
      return res
        .status(400)
        .json({ ok: false, error: "No fileBase64 provided" });
    }

    const buffer = decodeBase64Pdf(fileBase64);
    if (!buffer) {
      return res.status(400).json({ ok: false, error: "Invalid base64" });
    }

    const pdfDoc = await PDFDocument.load(buffer);
    const totalPages = pdfDoc.getPageCount();

    const outputs = [];

    for (let i = 0; i < totalPages; i++) {
      const newPdf = await PDFDocument.create();
      const [page] = await newPdf.copyPages(pdfDoc, [i]);
      newPdf.addPage(page);
      const bytes = await newPdf.save();
      outputs.push(bytes.toString("base64"));
    }

    return res.status(200).json({
      ok: true,
      files: outputs,
    });
  } catch (err) {
    console.error("split error:", err);
    return res.status(500).json({ ok: false, error: "Failed to split PDF" });
  }
});

// ============== 4) تدوير الصفحات ==============
// body: { fileBase64, direction: "left" | "right" }
app.post("/rotate", async (req, res) => {
  try {
    const { fileBase64, direction } = req.body || {};

    if (!fileBase64) {
      return res
        .status(400)
        .json({ ok: false, error: "No fileBase64 provided" });
    }

    const buffer = decodeBase64Pdf(fileBase64);
    if (!buffer) {
      return res.status(400).json({ ok: false, error: "Invalid base64" });
    }

    const pdfDoc = await PDFDocument.load(buffer);
    const pages = pdfDoc.getPages();

    const angle = direction === "left" ? -90 : 90;

    for (const page of pages) {
      const currentRotation = page.getRotation().angle || 0;
      page.setRotation(degrees(currentRotation + angle));
    }

    const rotatedBytes = await pdfDoc.save();

    return res.status(200).json({
      ok: true,
      fileBase64: rotatedBytes.toString("base64"),
    });
  } catch (err) {
    console.error("rotate error:", err);
    return res.status(500).json({ ok: false, error: "Failed to rotate PDF" });
  }
});

// ============== 5) قراءة الميتاداتا ==============
app.post("/metadata-read", async (req, res) => {
  try {
    const { fileBase64 } = req.body || {};

    if (!fileBase64) {
      return res
        .status(400)
        .json({ ok: false, error: "No fileBase64 provided" });
    }

    const buffer = decodeBase64Pdf(fileBase64);
    if (!buffer) {
      return res.status(400).json({ ok: false, error: "Invalid base64" });
    }

    const pdfDoc = await PDFDocument.load(buffer);

    const metadata = {
      title: pdfDoc.getTitle() || null,
      author: pdfDoc.getAuthor() || null,
      subject: pdfDoc.getSubject() || null,
      keywords: pdfDoc.getKeywords() || null,
      creator: pdfDoc.getCreator() || null,
      producer: pdfDoc.getProducer() || null,
    };

    return res.status(200).json({
      ok: true,
      metadata,
    });
  } catch (err) {
    console.error("metadata-read error:", err);
    return res
      .status(500)
      .json({ ok: false, error: "Failed to read metadata" });
  }
});

// ============== 6) تعديل الميتاداتا ==============
// body: { fileBase64, metadata: { title, author, subject, keywords, creator } }
app.post("/metadata-write", async (req, res) => {
  try {
    const { fileBase64, metadata } = req.body || {};

    if (!fileBase64) {
      return res
        .status(400)
        .json({ ok: false, error: "No fileBase64 provided" });
    }

    const buffer = decodeBase64Pdf(fileBase64);
    if (!buffer) {
      return res.status(400).json({ ok: false, error: "Invalid base64" });
    }

    const pdfDoc = await PDFDocument.load(buffer);

    if (metadata) {
      if (metadata.title) pdfDoc.setTitle(metadata.title);
      if (metadata.author) pdfDoc.setAuthor(metadata.author);
      if (metadata.subject) pdfDoc.setSubject(metadata.subject);
      if (metadata.keywords) pdfDoc.setKeywords(metadata.keywords);
      if (metadata.creator) pdfDoc.setCreator(metadata.creator);
    }

    const updatedBytes = await pdfDoc.save();

    return res.status(200).json({
      ok: true,
      fileBase64: updatedBytes.toString("base64"),
    });
  } catch (err) {
    console.error("metadata-write error:", err);
    return res
      .status(500)
      .json({ ok: false, error: "Failed to write metadata" });
  }
});

// ============== تشغيل السيرفر ==============
app.listen(PORT, () => {
  console.log(`PDF server running on port ${PORT}`);
});
