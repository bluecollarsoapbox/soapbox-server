// routes/witness-s3.js
const express = require('express');
const multer = require('multer');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const crypto = require('crypto');
const path = require('path');

const router = express.Router();

// --- simple health to prove router is mounted ---
// ⬇️ put this ABOVE the auth middleware so it skips auth
router.get('/witness/ping', (_req, res) => res.json({ ok: true }));

// --- simple health to prove router is mounted ---
router.get('/witness/ping', (_req, res) => res.json({ ok: true }));

// --- auth middleware: checks x-soapbox-key against env ---
function auth(req, res, next) {
  const got = req.header('x-soapbox-key') || '';
  if (!process.env.SOAPBOX_API_KEY) {
    return res.status(500).json({ error: 'Server misconfigured (no SOAPBOX_API_KEY)' });
  }
  if (got !== process.env.SOAPBOX_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// --- multer: keep file in memory and push to S3 ---
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 300 * 1024 * 1024 }, // 300MB
});

// --- S3 client from env ---
function s3() {
  const region = process.env.AWS_REGION || 'us-east-2';
  return new S3Client({
    region,
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '',
    },
  });
}

function safeSlug(s) {
  return String(s || '')
    .normalize('NFKD')
    .replace(/[^\w\- ]+/g, '')
    .trim()
    .replace(/[ ]+/g, '-')
    .slice(0, 80) || 'untitled';
}

router.post('/witness', auth, upload.single('video'), async (req, res) => {
  try {
    const bucket = process.env.S3_BUCKET;
    if (!bucket) return res.status(500).json({ error: 'Missing S3_BUCKET' });

    const { storyId = '', storyTitle = '' } = req.body || {};
    if (!storyId) return res.status(400).json({ error: 'storyId required' });
    if (!req.file) return res.status(400).json({ error: 'video file required' });

    const titleSlug = safeSlug(storyTitle || storyId);
    const now = new Date();
    const ts = now.toISOString().replace(/[:.]/g, '-');
    const extFromMime = (m) => {
      if (!m) return 'mp4';
      if (m.includes('quicktime')) return 'mov';
      if (m.includes('mp4')) return 'mp4';
      if (m.includes('webm')) return 'webm';
      return 'mp4';
    };
    const ext = extFromMime(req.file.mimetype);
    const hash = crypto.createHash('sha1').update(req.file.buffer).digest('hex').slice(0, 10);

    // S3 key layout: stories/<StoryId>/witnesses/<slug>-<timestamp>-<hash>.<ext>
    const key = `stories/${storyId}/witnesses/${titleSlug}-${ts}-${hash}.${ext}`;

    const put = new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: req.file.buffer,
      ContentType: req.file.mimetype || 'application/octet-stream',
      CacheControl: 'no-store',
    });

    await s3().send(put);

    const region = process.env.AWS_REGION || 'us-east-2';
    const url = `https://${bucket}.s3.${region}.amazonaws.com/${encodeURI(key)}`;

    return res.json({ ok: true, key, url });
  } catch (e) {
    console.error('witness upload error:', e);
    return res.status(500).json({ error: 'Upload failed' });
  }
});

module.exports = router;
