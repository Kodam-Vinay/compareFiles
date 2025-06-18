require("dotenv").config();
const express = require("express");
const pdfParse = require("pdf-parse");
const mammoth = require("mammoth");
const Diff = require("diff");
const PDFDocument = require("pdfkit");
const fileType = require("file-type");

const app = express();
const PORT = process.env.PORT || 8000;

app.use(express.json({limit: "20mb"}));

const SUPPORTED_MIME_TYPES = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
];

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

function generateDiffPDFBase64(diff, includeUnchanged = false) {
  return new Promise((resolve) => {
    const doc = new PDFDocument();
    const chunks = [];

    doc.on("data", chunk => chunks.push(chunk));
    doc.on("end", () => {
      const base64 = Buffer.concat(chunks).toString("base64");
      resolve(base64);
    });

    doc.font("Times-Roman").fontSize(12);
    if (!includeUnchanged) {
      doc.text("Changes between files:\n\n");
    }

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
        doc
          .moveTo(x, y + height / 2)
          .lineTo(x + width, y + height / 2)
          .strokeColor(color)
          .stroke();
      }
    });

    doc.end();
  });
}

async function detectMime(buffer, originalMime) {
  if (originalMime !== "application/octet-stream") return originalMime;
  const type = await fileType.fileTypeFromBuffer(buffer);
  return type?.mime || null;
}

function isSupportedMime(mimeType) {
  return SUPPORTED_MIME_TYPES.includes(mimeType);
}

async function extractText(buffer, mime) {
  switch (mime) {
    case "application/pdf":
      return (await pdfParse(buffer)).text;
    case "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
      return (await mammoth.extractRawText({ buffer })).value;
    default:
      throw new Error("Unsupported MIME type.");
  }
}

app.post("/compare", async (req, res) => {
  try {
    const files = req.body;
    if (!Array.isArray(files) || files.length < 2) {
      return res.status(400).json({ status: false, message: "At least two files are required." });
    }

    const validFiles = files.filter(f => f?.["$content-type"] && f?.["$content"] && isSupportedMime(f["$content-type"])).slice(0, 2);

    if (validFiles.length < 2) {
      return res.status(400).json({ status: false, message: "At least two valid .docx or .pdf files are required." });
    }

    const [file1, file2] = validFiles;
    if (file1["$content-type"] !== file2["$content-type"]) {
      return res.status(400).json({ status: false, message: "Both files must be of the same type (.docx or .pdf)." });
    }

    const buffer1 = Buffer.from(file1["$content"], "base64");
    const buffer2 = Buffer.from(file2["$content"], "base64");

    const text1 = await extractText(buffer1, file1["$content-type"]);
    const text2 = await extractText(buffer2, file2["$content-type"]);

    const diff = Diff.diffLines(text1, text2);
    generateDiffPDF(diff, res, true);

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
        const mimeType = await detectMime(buffer, file?.["$content-type"]);
        return { ...file, "$content-type": mimeType, $buffer: buffer };
      })
    );

    const validFiles = enrichedFiles.filter(f => isSupportedMime(f["$content-type"]));

    if (validFiles.length < 2) {
      return res.status(400).json({ status: false, message: "At least two valid .docx or .pdf files are required." });
    }

    if (validFiles[0]["$content-type"] !== validFiles[1]["$content-type"]) {
      return res.status(400).json({ status: false, message: "Both files must be of the same type (.docx or .pdf)." });
    }

    const texts = await Promise.all(
      validFiles.map(file => extractText(file.$buffer, file["$content-type"]))
    );

    const diff = Diff.diffLines(texts[0], texts[1]);

   const [pdf1, pdf2, pdfDiff] = await Promise.all([
      generateBase64Pdf(texts[0]),
      generateBase64Pdf(texts[1]),
      generateDiffPDFBase64(diff)
    ]);

    res.json({
      status: true,
      message: "Comparison completed",
      files: {
        file1: { "$content-type": "application/pdf", "$content": pdf1 },
        file2: { "$content-type": "application/pdf", "$content": pdf2 },
        diff:  { "$content-type": "application/pdf", "$content": pdfDiff }
      }
    });
  } catch (err) {
    console.error("Error:", err);
    res.status(500).json({ status: false, message: "Internal Server Error" });
  }
});

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));