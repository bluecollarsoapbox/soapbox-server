// routes/witness-s3.js
const express = require("express");
const path = require("path");
const { PassThrough } = require("stream");
const multer = require("multer");
const ffmpeg = require("fluent-ffmpeg");
const ffmpegPath = require("ffmpeg-static");
const fetch = require("node-fetch"); // v2
const mime = require("mime-types");
const { S3Client, PutObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

ffmpeg.setFfmpegPath(ffmpegPath);

const router = express.Router();

// --- ENV ---
const API_KEY = process.env.SOAPBOX_API_KEY || "";
const AWS_REGION = process.env.AWS_REGION || "us-east-2";
const S3_BUCKET = process.env.S3_BUCKET;
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || ""; // optional
if (!S3_BUCKET) console.warn("[witness-s3] Missing S3_BUCKET env");

// --- S3 ---
const s3 = new S3Client({ region: AWS_REGION });

async function s3Put({ Key, Body, ContentType }) {
  await s3.send(
    new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key,
      Body,
      ContentType,
      ACL: "private",
    })
  );
  return Key;
}

async function s3SignedGet(Key, seconds = 3600) {
  return await getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: S3_BUCKET, Key }),
    { expiresIn: seconds }
  );
}

// --- Auth ---
function requireKey(req, res, next) {
  const k = req.header("x-soapbox-key");
  if (!API_KEY || k === API_KEY) return next();
  return res.status(401).json({ error: "Unauthorized" });
}

// --- Helpers ---
function slug(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-") || "story";
}

function bufferToStream(buf) {
  const ps = new PassThrough();
  ps.end(buf);
  return ps;
}

// Multer memory storage (we stream to ffmpeg & S3)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 1024 * 1024 * 1024 }, // 1GB
  fileFilter: (_req, file, cb) => {
    // Accept any video mimetype; if missing, still allow (curl on Windows can omit it)
    if (!file.mimetype || file.mimetype.startsWith("video/")) return cb(null, true);
    return cb(null, true);
  },
});

// ---------- ROUTE: POST /api/witness ----------
router.post("/api/witness", requireKey, upload.single("video"), async (req, res) => {
  try {
    const storyId = String(req.body.storyId || "Story1");
    const storyTitle = String(req.body.storyTitle || storyId);

    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ error: 'No video uploaded. Field must be "video".' });
    }

    // derive extension
    let ext =
      (req.file.originalname && path.extname(req.file.originalname).toLowerCase()) ||
      "." + (mime.extension(req.file.mimetype || "") || "mp4");

    // safe base name
    const baseSafe =
      (storyTitle || storyId).replace(/[^\w\- ]+/g, "").replace(/\s+/g, "_") ||
      storyId;
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const baseName = `${baseSafe}_${ts}${ext}`;

    // ORIGINAL → S3
    const origKey = `${storyId}/witnesses/originals/${baseName}`;
    const origType = req.file.mimetype || mime.lookup(ext) || "video/mp4";
    await s3Put({ Key: origKey, Body: req.file.buffer, ContentType: origType });

    // WATERMARK PREVIEW (full-screen faded)
    const logoPath = path.join(__dirname, "..", "assets", "logo.png");
    const inStream = bufferToStream(req.file.buffer);
    const outStream = new PassThrough();

    const filter =
      // scale input to width 1920 (keep AR), make yuv420p for compatibility
      // stack a dim layer, then overlay full-screen logo with ~18% alpha
      "[0:v]scale=1920:-2,format=rgba[vid];" +
      "color=c=black@0.15:s=1920x1080[dim];" +
      "[vid][dim]overlay=0:0[base];" +
      "[1:v]scale=main_w:main_h,format=rgba,colorchannelmixer=aa=0.18[wm];" +
      "[base][wm]overlay=0:0";

    ffmpeg({ timeout: 0 })
      .input(inStream)
      .input(logoPath)
      .complexFilter(filter)
      .outputOptions(["-c:v libx264", "-preset veryfast", "-crf 23", "-c:a copy", "-movflags +faststart"])
      .format("mp4")
      .on("error", (err) => {
        console.error("ffmpeg error:", err);
        outStream.destroy(err);
      })
      .on("end", () => outStream.end())
      .pipe(outStream);

    const previewKey = `${storyId}/witnesses/previews/${baseName.replace(ext, "_wm.mp4")}`;
    await s3Put({ Key: previewKey, Body: outStream, ContentType: "video/mp4" });

    // Optional: Discord notify with signed preview link
    if (DISCORD_WEBHOOK_URL) {
      try {
        const signedPreview = await s3SignedGet(previewKey, 3600);
        const content = `**Witness Video**\nStory: ${storyTitle}\n${signedPreview}`;
        await fetch(DISCORD_WEBHOOK_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content }),
        });
      } catch (e) {
        console.warn("discord webhook failed:", e?.message || e);
      }
    }

    return res.json({
      ok: true,
      id: baseName,
      storyId,
      title: storyTitle,
      original: { key: origKey },
      preview: { key: previewKey },
      // If you ever re-enable feed, you could return a public/signed URL here.
    });
  } catch (e) {
    console.error("witness-s3 upload failed:", e);
    return res.status(500).json({ error: "Upload failed", detail: String(e?.message || e) });
  }
});

module.exports = router;
