const express = require("express");
const fs = require("fs").promises;
const { diffWords, diffLines } = require("diff");
const mammoth = require("mammoth");
const fileType = require("file-type");
const PDFDocument = require("pdfkit");
const libre = require("libreoffice-convert");
const util = require("util");
const convertAsync = util.promisify(libre.convert);
const app = express();
app.use(express.json({ limit: "20mb" }));
const PORT = process.env.PORT || 8000;
 
function isSupportedMime(mime) {
  return [
    "application/pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  ].includes(mime);
}
 
async function detectMime(buffer, originalMime) {
  if (originalMime !== "application/octet-stream") return originalMime;
  const type = await fileType.fromBuffer(buffer);
  return type?.mime || null;
}
 
async function extractText(buffer, mime) {
  if (mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
    return (await mammoth.extractRawText({ buffer })).value;
  }
  throw new Error("Only .docx is supported currently.");
}
 
async function convertToPdfBuffer(inputBuffer) {
  return await convertAsync(inputBuffer, '.pdf', undefined);
}
 
function generateDiffPDFBuffer(diff) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument();
    const chunks = [];
    doc.on("data", chunk => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
 
    doc.font("Times-Roman").fontSize(12).text("Word-by-word differences:\n\n");
    diff.forEach(part => {
      const color = part.added ? "green" : part.removed ? "red" : "black";
      doc.fillColor(color).text(part.value.trim() || " ");
    });
 
    doc.end();
  });
}
 
function generateBase64Pdf(text) {
  return new Promise(resolve => {
    const chunks = [];
    const doc = new PDFDocument();
    doc.on("data", chunk => chunks.push(chunk));
    doc.on("end", () => {
      const base64 = Buffer.concat(chunks).toString("base64");
      resolve(base64);
    });
    doc.font("Times-Roman").fontSize(12).text(text || "No content available");
    doc.end();
  });
}
 
function generateDiffPDFBase64(diff, includeUnchanged = true) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument();
    const chunks = [];
    doc.on("data", chunk => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks).toString("base64")));
 
    doc.font("Times-Roman").fontSize(12);
    if (!includeUnchanged) doc.text("Changes between files:\n\n");
 
    diff.forEach(part => {
      const unchanged = !part.added && !part.removed;
      if (!includeUnchanged && unchanged) return;
      const color = part.added ? "green" : part.removed ? "red" : "black";
      const text = part.value.trim();
      if (!text) return;
      const x = doc.x, y = doc.y;
      doc.fillColor(color).text(text);
      if (part.removed) {
        const width = doc.widthOfString(text);
        const height = doc.currentLineHeight();
        doc.moveTo(x, y + height / 2).lineTo(x + width, y + height / 2).strokeColor(color).stroke();
      }
    });
 
    doc.end();
  });
}
 
app.post("/compare", async (req, res) => {
  try {
    const files = req.body;
    if (!Array.isArray(files) || files.length < 2) {
      return res.status(400).json({ status: false, message: "At least two files are required." });
    }
 
    const [file1, file2] = files.slice(0, 2);
    const buffer1 = Buffer.from(file1?.["$content"], "base64");
    const buffer2 = Buffer.from(file2?.["$content"], "base64");
 
    const mime1 = file1?.["$content-type"];
    const mime2 = file2?.["$content-type"];
 
    if (mime1 !== mime2 || !isSupportedMime(mime1)) {
      return res.status(400).json({ status: false, message: "Both files must be of the same supported type (.docx or .pdf)." });
    }
 
    const [text1, text2] = await Promise.all([
      extractText(buffer1, mime1),
      extractText(buffer2, mime2)
    ]);
 
    const diff = diffLines(text1, text2);
    const base64 = await generateDiffPDFBase64(diff);
    return res.json({ "$content-type": "application/pdf", "$content": base64 });
  } catch (err) {
    console.error("Error:", err);
    res.status(500).json({ status: false, message: "Internal Server Error" });
  }
});
 
app.post("/compare/v2", async (req, res) => {
  try {
    const files = req.body;
    if (!Array.isArray(files) || files.length < 2) {
      return res.status(400).json({ status: false, message: "At least two files are required." });
    }
 
    const enrichedFiles = await Promise.all(
      files.map(async file => {
        const buffer = Buffer.from(file?.["$content"], "base64");
        const mime = await detectMime(buffer, file?.["$content-type"]);
        return { buffer, mime };
      })
    );
 
    const [file1, file2] = enrichedFiles.slice(0, 2);
    if (file1.mime !== file2.mime || !isSupportedMime(file1.mime)) {
      return res.status(400).json({ status: false, message: "Both files must be of the same supported type." });
    }
 
    const [text1, text2] = await Promise.all([
      extractText(file1.buffer, file1.mime),
      extractText(file2.buffer, file2.mime)
    ]);
 
    const diff = diffLines(text1, text2);
    const result = await Promise.all([
      generateBase64Pdf(text1),
      generateBase64Pdf(text2),
      generateDiffPDFBase64(diff)
    ]);
 
    return res.json({
      status: true,
      message: "Comparison completed",
      data: result.map(base64 => ({ "$content-type": "application/pdf", "$content": base64 }))
    });
  } catch (err) {
    console.error("Error:", err);
    res.status(500).json({ status: false, message: "Internal Server Error" });
  }
});
 
app.post("/compare/v3", async (req, res) => {
  try {
    const files = req.body;
    if (!Array.isArray(files) || files.length < 2) {
      return res.status(400).json({ status: false, message: "At least two files are required." });
    }
 
    const enriched = await Promise.all(
      files.slice(0, 2).map(async file => {
        const buffer = Buffer.from(file["$content"], "base64");
        const mime = await detectMime(buffer, file["$content-type"]);
        return { buffer, mime };
      })
    );
 
    const [file1, file2] = enriched;
    if (file1.mime !== file2.mime || file1.mime !== "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
      return res.status(400).json({ status: false, message: "Only .docx files of same type supported." });
    }
 
    const [text1, text2] = await Promise.all([
      extractText(file1.buffer, file1.mime),
      extractText(file2.buffer, file2.mime)
    ]);
 
    const diff = diffWords(text1, text2);
    const [pdf1, pdf2, diffPdf] = await Promise.all([
      convertToPdfBuffer(file1.buffer),
      convertToPdfBuffer(file2.buffer),
      generateDiffPDFBuffer(diff)
    ]);
 
    return res.status(200).json({
      status: true,
      message: "Comparison complete",
      data: [
        { "$content-type": "application/pdf", "$content": pdf1.toString("base64") },
        { "$content-type": "application/pdf", "$content": pdf2.toString("base64") },
        { "$content-type": "application/pdf", "$content": diffPdf.toString("base64") }
      ]
    });
  } catch (err) {
    console.error("Error in /compare/v3:", err);
    res.status(500).json({ status: false, message: err.message });
  }
});
 
app.listen(PORT, () => console.log(`\u2728 Server running on port ${PORT}`));