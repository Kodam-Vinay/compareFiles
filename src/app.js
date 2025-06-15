require("dotenv").config();
const express = require("express");
const multer = require("multer");
const mammoth = require("mammoth");
const pdfParse = require("pdf-parse");
const Diff = require("diff");
const PDFDocument = require("pdfkit");

const app = express();
const PORT = process.env.PORT || 8000;

const upload = multer({ storage: multer.memoryStorage() }).fields([
  { name: "file1", maxCount: 1 },
  { name: "file2", maxCount: 1 },
]);

app.post("/compare", upload, async (req, res) => {
  try {
    const file1 = req.files["file1"]?.[0];
    const file2 = req.files["file2"]?.[0];

    if (!file1 || !file2) {
      return res
        .status(400)
        .json({ status: false, message: "Both files are required." });
    }

    if (file1.mimetype !== file2.mimetype) {
      return res
        .status(400)
        .json({ status: false, message: "Files must be the same type." });
    }

    const text1 = await extractText(file1);
    const text2 = await extractText(file2);
    const diff = Diff.diffLines(text1, text2);

    // Generate PDF from diff
    const doc = new PDFDocument();
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      "attachment; filename=diff-result.pdf"
    );
    doc.pipe(res);

    diff.forEach((part) => {
      const color = part.added ? "green" : part.removed ? "red" : "black";
      doc.fillColor(color).text(part.value, { continued: false });
    });

    doc.end();
  } catch (err) {
    console.error("Error:", err);
    res.status(500).json({ status: false, message: "Internal Server Error" });
  }
});

async function extractText(file) {
  const mime = file.mimetype;

  if (mime === "application/pdf") {
    const data = await pdfParse(file.buffer);
    return data.text;
  }

  if (
    mime ===
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  ) {
    const result = await mammoth.extractRawText({ buffer: file.buffer });
    return result.value;
  }

  throw new Error("Unsupported file type: " + mime);
}

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
