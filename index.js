require("dotenv").config();
const express = require("express");
const pdfParse = require("pdf-parse");
const mammoth = require("mammoth");
const Diff = require("diff");
const PDFDocument = require("pdfkit");
const fileType = require("file-type");

const app = express();
const PORT = process.env.PORT || 8000;

app.use(express.json({ limit: "20mb" }));

async function detectMime(buffer, originalMime) {
  if (originalMime !== "application/octet-stream") return originalMime;

  const type = await fileType.fileTypeFromBuffer(buffer);
  if (!type) return null;
  return type.mime;
}

function isSupportedMime(mimeType) {
  return [
    "application/pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ].includes(mimeType);
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


app.post("/compare", async (req, res) => {
  try {
    const files = req.body;

    if (!Array.isArray(files) || files.length < 2) {
      return res.status(400).json({
        status: false,
        message: "At least two files are required."
      });
    }

    const validFiles = files
      .filter(f =>
        f?.["$content-type"] &&
        f?.["$content"] &&
        isSupportedMime(f?.["$content-type"])
      )
      .slice(0, 2);

    if (validFiles.length < 2) {
      return res.status(400).json({
        status: false,
        message: "At least two valid .docx or .pdf files are required."
      });
    }

    const [file1, file2] = validFiles;

    const buffer1 = Buffer.from(file1?.["$content"], "base64");
    const buffer2 = Buffer.from(file2?.["$content"], "base64");

    const mime1 = file1?.["$content-type"];
    const mime2 = file2?.["$content-type"];

    if (mime1 !== mime2) {
      return res.status(400).json({
        status: false,
        message: "Both files must be of the same type (.docx or .pdf)."
      });
    }


    const text1 = await extractText(buffer1, mime1);
    const text2 = await extractText(buffer2, mime2);

    const diff = Diff.diffLines(text1, text2);

    // Generate PDF to buffer
    const chunks = [];
    const doc = new PDFDocument();
    doc.on("data", chunk => chunks.push(chunk));
    doc.on("end", () => {
      const pdfBuffer = Buffer.concat(chunks);
      const base64PDF = pdfBuffer.toString("base64");

      return res.json({
        "$content-type": "application/pdf",
        "$content": base64PDF
      });
    });

    
    diff.forEach(part => {
      const color = part.added ? "green" : part.removed ? "red" : "black";
      const text = part.value;
      const x = doc.x;
      const y = doc.y;

      doc.fillColor(color).text(text, { continued: false });

      if (color === "red") {
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
  } catch (err) {
    console.error("Error:", err);
    res.status(500).json({ status: false, message: "Internal Server Error" });
  }
});

//file comparison using versions api
app.post("/compare/v2", async (req, res) => {
  try {
    const files = req.body;
    
    if (!Array.isArray(files) || files.length < 2) {
      return res.status(400).json({
        status: false,
        message: "At least two files are required."
      });
    }
    
    //changing content type of each file
    const contetFiles = await Promise.all(
    files.map(async (file) => {
      const buffer = Buffer.from(file?.["$content"], "base64");
      const mimeType = await detectMime(buffer, file?.["$content-type"]);
      file["$content-type"] = mimeType;
      file["$buffer"] = buffer
      return file;
    })
  );

  const validFiles = contetFiles.filter(file => isSupportedMime(file?.["$content-type"]))
    
  if (validFiles.length < 2) {
      return res.status(400).json({
        status: false,
        message: "At least two valid .docx or .pdf files are required."
      });
    }

  if (validFiles[0]?.["$content-type"] !== validFiles[1]?.["$content-type"]) {
    return res.status(400).json({
      status: false,
      message: "Both files must be of the same type (.docx or .pdf)."
    });
  }
  const textsFromEachFile = await Promise.all(validFiles.map(async function(file){
     return await extractText(file?.["$buffer"],file["$content-type"])
  }))
    const diff = Diff.diffLines(textsFromEachFile[0], textsFromEachFile[1]);

    // Generate PDF with only changes
    const chunks = [];
    const doc = new PDFDocument();
    doc.on("data", chunk => chunks.push(chunk));
    doc.on("end", () => {
      const pdfBuffer = Buffer.concat(chunks);
      const base64PDF = pdfBuffer.toString("base64");

      return res.json({
        "$content-type": "application/pdf",
        "$content": base64PDF
      });
    });

    doc.font("Times-Roman").fontSize(12).text("Changes between files:\n\n");

    diff.forEach(part => {
      if (!part.added && !part.removed) return; // Skip unchanged

      const color = part.added ? "green" : "red";
      const text = part.value.trim();

      if (!text) return; // skip empty changes

      const x = doc.x;
      const y = doc.y;

      doc.fillColor(color).text(text, { continued: false });

      if (part.removed) {
        // Apply strikethrough to removed text
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
  } catch (err) {
    console.error("Error:", err);
    res.status(500).json({ status: false, message: "Internal Server Error" });
  }
});

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
 