require("dotenv").config();
const express = require("express");
const pdfParse = require("pdf-parse");
const mammoth = require("mammoth");
const Diff = require("diff");
const PDFDocument = require("pdfkit");

const app = express();
const PORT = process.env.PORT || 8000;

app.use(express.json({ limit: "20mb" }));

app.post("/compare", async (req, res) => {
  try {
    const files = req.body;

    if (!Array.isArray(files) || files.length !== 2) {
      return res.status(400).json({
        status: false,
        message: "Send exactly two files in an array with 'name' and 'contentBytes'."
      });
    }

    const [file1, file2] = files;

    if (!file1?.contentBytes || !file2?.contentBytes || !file1?.name || !file2?.name) {
      return res.status(400).json({
        status: false,
        message: "Each file must include 'name' and 'contentBytes'."
      });
    }

    const buffer1 = Buffer.from(file1.contentBytes, "base64");
    const buffer2 = Buffer.from(file2.contentBytes, "base64");

    const mime1 = guessMimeType(file1.name);
    const mime2 = guessMimeType(file2.name);

    if (!mime1 || !mime2) {
      return res.status(400).json({
        status: false,
        message: "Unsupported file type. Only .docx and .pdf files are allowed."
      });
    }

    if (mime1 !== mime2) {
      return res.status(400).json({
        status: false,
        message: "Both files must be of the same type (.docx or .pdf)."
      });
    }

    const text1 = await extractText(buffer1, mime1);
    const text2 = await extractText(buffer2, mime2);

    const diff = Diff.diffLines(text1, text2);

    const doc = new PDFDocument();
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", "attachment; filename=diff-result.pdf");
    doc.pipe(res);

    diff.forEach(part => {
      const color = part.added ? "green" : part.removed ? "red" : "black";
      doc.fillColor(color).text(part.value, { continued: false });
    });

    doc.end();

  } catch (err) {
    console.error("Error:", err);
    res.status(500).json({ status: false, message: "Internal Server Error" });
  }
});

function guessMimeType(fileName) {
  if (fileName.toLowerCase().endsWith(".pdf")) {
    return "application/pdf";
  }
  if (fileName.toLowerCase().endsWith(".docx")) {
    return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  }
  return null;
}

async function extractText(buffer, mime) {
  if (mime === "application/pdf") {
    const data = await pdfParse(buffer);
    return data.text;
  }
  if (mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
    const result = await mammoth.extractRawText({ buffer });
    return result.value;
  }
  throw new Error("Unsupported MIME type.");
}

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
