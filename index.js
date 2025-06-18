require("dotenv").config();
const express = require("express");
const pdfParse = require("pdf-parse");
const mammoth = require("mammoth");
const Diff = require("diff");
const PDFDocument = require("pdfkit");
const fileType = require("file-type");

app.use(express.json({ limit: "20mb" }));
const PORT = process.env.PORT || 8000;

app.use(express.json());

const SUPPORTED_MIME_TYPES = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
];

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

function generateDiffPDF(diff, res, includeUnchanged = false) {
  const chunks = [];
  const doc = new PDFDocument();

  doc.on("data", chunk => chunks.push(chunk));
  doc.on("end", () => {
    const base64PDF = Buffer.concat(chunks).toString("base64");
    res.json({ "$content-type": "application/pdf", "$content": base64PDF });
  });

  doc.font("Times-Roman").fontSize(12);
  if (!includeUnchanged) doc.text("Changes between files:\n\n");

  diff.forEach(part => {
    const unchanged = !part.added && !part.removed;
    if (!includeUnchanged && unchanged) return;

    const color = part.added ? "green" : part.removed ? "red" : "black";
    const text = part.value.trim();
    if (!text) return;

    const x = doc.x, y = doc.y;
    doc.fillColor(color).text(text, { continued: false });

    if (part.removed) {
      const textWidth = doc.widthOfString(text);
      const textHeight = doc.currentLineHeight();
      doc
        .moveTo(x, y + textHeight / 2)
        .lineTo(x + textWidth, y + textHeight / 2)
        .strokeColor(color)
        .stroke();
    }
  });

  doc.end();
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
    generateDiffPDF(diff, res);

  } catch (err) {
    console.error("Error:", err);
    res.status(500).json({ status: false, message: "Internal Server Error" });
  }
});

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));