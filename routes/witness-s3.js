// routes/witness-s3.js
// Single responsibility: accept a witness video and push to S3 at
// s3://{S3_BUCKET}/stories/{storyId}/witnesses/{timestamp}_{safeTitle}.{ext}

const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const path = require('path');

const {
  S3Client,
  PutObjectCommand,
} = require('@aws-sdk/client-s3');

const router = express.Router();

// ---- Env / config ----
const API_KEY = process.env.SOAPBOX_API_KEY || '';
const AWS_REGION = process.env.AWS_REGION || 'us-east-2';
const S3_BUCKET = process.env.S3_BUCKET;

if (!S3_BUCKET) {
  console.warn('[witness-s3] S3_BUCKET is not set — uploads will fail');
}

const s3 = new S3Client({ region: AWS_REGION });

// Memory storage: Render has limited ephemeral disk; we stream straight to S3
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 200 * 1024 * 1024, // 200 MB cap
  },
  fileFilter: (_req, file, cb) => {
    const okTypes = [
      'video/mp4',
      'video/quicktime',
      'video/x-matroska',
      'video/webm',
      'video/3gpp',
      'video/3gpp2',
      'application/octet-stream', // some Androids
    ];
    if (okTypes.includes(file.mimetype)) return cb(null, true);
    cb(new Error('Unsupported file type'));
  },
});

// Simple API key check
function requireKey(req, res, next) {
  if (!API_KEY) return res.status(500).json({ error: 'Server not configured (API key missing)' });
  const got = req.get('x-soapbox-key') || '';
  if (got !== API_KEY) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

function safeName(s) {
  return String(s || '')
    .normalize('NFKD')
    .replace(/[^\w\s.-]/g, '')
    .replace(/\s+/g, '_')
    .slice(0, 80) || 'untitled';
}

function extFromFilename(name, fallback = '.mp4') {
  const e = path.extname(name || '').toLowerCase();
  return e || fallback;
}

// POST /api/witness  (mounted from server.js with app.use('/api', router))
router.post(
  '/witness',
  requireKey,
  upload.single('video'),
  async (req, res) => {
    try {
      const { storyId, storyTitle } = req.body || {};
      if (!storyId) return res.status(400).json({ error: 'storyId required' });
      if (!req.file) return res.status(400).json({ error: 'video file required (field name: video)' });
      if (!S3_BUCKET) return res.status(500).json({ error: 'S3_BUCKET not configured' });

      const now = new Date();
      const ts = now.toISOString().replace(/[:.]/g, '-');
      const titleSafe = safeName(storyTitle || storyId);
      const guessedExt = extFromFilename(req.file.originalname, req.file.mimetype === 'video/quicktime' ? '.mov' : '.mp4');

      const key = [
        'stories',
        String(storyId),
        'witnesses',
        `${ts}_${titleSafe}${guessedExt}`,
      ].join('/');

      const put = new PutObjectCommand({
        Bucket: S3_BUCKET,
        Key: key,
        Body: req.file.buffer,
        ContentType: req.file.mimetype || 'application/octet-stream',
        Metadata: {
          storyId: String(storyId),
          storyTitle: String(storyTitle || ''),
          uploadId: crypto.randomBytes(8).toString('hex'),
        },
      });

      await s3.send(put);

      return res.json({
        ok: true,
        bucket: S3_BUCKET,
        key,
        size: req.file.size,
        mime: req.file.mimetype,
      });
    } catch (err) {
      console.error('[witness-s3] upload error:', err);
      return res.status(500).json({ error: 'Upload failed' });
    }
  }
);

module.exports = router;
