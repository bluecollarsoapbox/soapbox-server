// server.js — Blue Collar Soapbox API (INLINE S3 witness route + bot)

// ---------- Env & Core ----------
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const crypto = require('crypto');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

const app = express();

// ---------- Middleware ----------
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ---------- Config ----------
const SOAPBOX_KEY = process.env.SOAPBOX_API_KEY || process.env.API_KEY || '';
const S3_BUCKET   = process.env.S3_BUCKET;                  // e.g. soapbox-app-data
const S3_REGION   = process.env.AWS_REGION || 'us-east-2';  // your chosen region

// AWS creds are read from env: AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY
const s3 = new S3Client({ region: S3_REGION });

// ---------- Helpers ----------
const sanitize = (s) =>
  String(s || '').replace(/[^\w\-\s.]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80);

const pickExt = (original, mimetype) => {
  const ext = path.extname(original || '').toLowerCase();
  if (ext) return ext;
  if (/quicktime/i.test(mimetype)) return '.mov';
  if (/mp4/i.test(mimetype)) return '.mp4';
  return '.mp4';
};

// Multer (memory)
const uploadMem = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 200 * 1024 * 1024 }, // 200 MB
});

// ---------- Auth helper ----------
function requireKey(req, res) {
  const k = req.header('x-soapbox-key') || '';
  if (!SOAPBOX_KEY || k !== SOAPBOX_KEY) {
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }
  return true;
}

// ---------- Witness handlers (S3) ----------
app.get(['/witness/ping', '/api/witness/ping'], (req, res) => {
  if (!requireKey(req, res)) return;
  res.json({ ok: true });
});

async function handleWitnessPost(req, res) {
  try {
    if (!requireKey(req, res)) return;

    if (!S3_BUCKET) return res.status(500).json({ error: 'S3 bucket not configured' });
    if (!req.file)   return res.status(400).json({ error: 'video file required (field "video")' });

    const { storyId, storyTitle } = req.body || {};
    if (!storyId) return res.status(400).json({ error: 'storyId required' });

    const cleanId    = sanitize(storyId);                 // e.g. Story1
    const cleanTitle = sanitize(storyTitle) || cleanId;   // e.g. Crawl Space vs. Concrete

    const ext   = pickExt(req.file.originalname, req.file.mimetype);
    const stamp = new Date().toISOString().replace(/[:.]/g, '').replace('T', '_').slice(0, 15);
    const rand  = crypto.randomBytes(3).toString('hex');

    // S3 layout you wanted
    const key = `stories/${cleanId}/witnesses/${stamp}_${rand}_${cleanTitle}${ext}`;

    await s3.send(new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: key,
      Body: req.file.buffer,
      ContentType: req.file.mimetype || 'application/octet-stream',
    }));

    res.json({
      ok: true,
      bucket: S3_BUCKET,
      key,
      size: req.file.size,
      contentType: req.file.mimetype || null,
    });
  } catch (e) {
    console.error('[witness->s3] upload error:', e);
    res.status(500).json({ error: 'Upload failed' });
  }
}

app.post('/witness', uploadMem.single('video'), handleWitnessPost);
app.post('/api/witness', uploadMem.single('video'), handleWitnessPost);

// ---------- Health & Errors ----------
app.get('/health', (_req, res) => res.json({ ok: true }));

app.use((_req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, _req, res, _next) => {
  console.error('API error:', err);
  res.status(err.status || 500).json({ error: err.message || 'Server error' });
});

// ---------- Start Express ----------
const PORT = Number(process.env.PORT) || 3030;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`API listening on :${PORT}`);
});

// ---------- Start Discord bot ----------
try {
  require('./bot');
  console.log('✅ Discord bot started');
} catch (e) {
  console.error('❌ Bot start failed:', e);
}
