// routes/witness-s3.js  — S3 upload for witness videos
const express = require('express');
const router = express.Router();

const multer = require('multer');
const path = require('path');
const crypto = require('crypto');

const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

// Log when this router is loaded (helps confirm Render picked it up)
console.log('[witness-s3] router loaded');

// ---------- Env / S3 client ----------
const REQ_KEY = process.env.SOAPBOX_API_KEY || process.env.API_KEY || '';
const S3_BUCKET = process.env.S3_BUCKET;
const S3_REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-2';

if (!S3_BUCKET) {
  console.warn('[witness-s3] WARNING: S3_BUCKET is not set — uploads will fail.');
}

const s3 = new S3Client({
  region: S3_REGION,
  // On Render, set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY in Environment
});

// ---------- Helpers ----------
const sanitize = (s) =>
  String(s || '')
    .replace(/[^\w\-\s.]/g, '')     // keep letters, numbers, _, -, space, dot
    .replace(/\s+/g, ' ')           // collapse spaces
    .trim()
    .slice(0, 80);                  // keep it short

const pickExt = (original, mimetype) => {
  const ext = path.extname(original || '').toLowerCase();
  if (ext) return ext;
  if (/quicktime/i.test(mimetype)) return '.mov';
  if (/mp4/i.test(mimetype)) return '.mp4';
  return '.mp4';
};

// ---------- Multer (memory) ----------
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 200 * 1024 * 1024, // 200MB
  },
});

// ---------- Routes ----------
router.get('/witness/test', (_req, res) => {
  res.json({ ok: true, route: '/api/witness/test' });
});

router.post('/witness', upload.single('video'), async (req, res) => {
  try {
    // Auth
    const headerKey = req.headers['x-soapbox-key'] || '';
    if (!REQ_KEY || headerKey !== REQ_KEY) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { storyId, storyTitle } = req.body || {};
    if (!storyId) return res.status(400).json({ error: 'storyId required' });
    if (!req.file) return res.status(400).json({ error: 'video file required (field name "video")' });

    const cleanId = sanitize(storyId);
    const cleanTitle = sanitize(storyTitle) || cleanId;

    const ext = pickExt(req.file.originalname, req.file.mimetype);
    const stamp = new Date().toISOString().replace(/[:.]/g, '').replace('T','_').slice(0,15);
    const rand = crypto.randomBytes(3).toString('hex');

    // S3 key structure you asked for: stories/Story1/witnesses/<timestamp>_<rand>_<title>.ext
    const s3Key = `stories/${cleanId}/witnesses/${stamp}_${rand}_${cleanTitle}${ext}`;

    const put = new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: s3Key,
      Body: req.file.buffer,
      ContentType: req.file.mimetype || 'application/octet-stream',
      // default ACL is private (good). We can add encryption if you want later.
    });

    await s3.send(put);

    // respond with where it went
    res.json({
      ok: true,
      bucket: S3_BUCKET,
      key: s3Key,
      size: req.file.size,
      contentType: req.file.mimetype || null,
    });
  } catch (e) {
    console.error('[witness-s3] upload error:', e);
    res.status(500).json({ error: 'Upload failed' });
  }
});

module.exports = router;
