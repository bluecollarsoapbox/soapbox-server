// server.js — Blue Collar Soapbox API (stories + witness + links-from-S3 + bot)

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs/promises');
const fssync = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
} = require('@aws-sdk/client-s3');

const app = express();
app.disable('x-powered-by');
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ---------- Local Stories (unchanged) ----------
const STORIES_DIR = path.join(__dirname, 'Stories'); // Story1/Story2/... live here
app.use('/static', express.static(STORIES_DIR, { fallthrough: true })); // thumbs/witnesses for the app

// ---------- Config ----------
const SOAPBOX_KEY = process.env.SOAPBOX_API_KEY || process.env.API_KEY || '';
const S3_BUCKET   = (process.env.S3_BUCKET || '').trim();        // e.g. soapbox-app-data
const S3_REGION   = (process.env.AWS_REGION || 'us-east-2').trim();
const s3 = new S3Client({ region: S3_REGION }); // expects AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY

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

async function safeRead(p) { try { return (await fs.readFile(p, 'utf8')).trim(); } catch { return ''; } }
function existsSync(p) { try { fssync.accessSync(p); return true; } catch { return false; } }

async function readStoryPresentation(storyDir, storyId) {
  const headline = await safeRead(path.join(storyDir, 'headline.txt'));
  const subtitle = await safeRead(path.join(storyDir, 'subtitle.txt'));

  const thumbCandidates = [
    'thumbYT.jpg','thumbYT.png',
    'thumb.jpg','thumb.png',
    'thumbnail.jpg','thumbnail.png'
  ];
  let thumbUrl = '';
  for (const name of thumbCandidates) {
    const full = path.join(storyDir, name);
    if (existsSync(full)) {
      const v = (fssync.statSync(full).mtimeMs | 0);
      thumbUrl = `/static/${encodeURIComponent(path.basename(storyDir))}/${encodeURIComponent(name)}?v=${v}`;
      break;
    }
  }

  // Optional metadata.json to fill gaps
  try {
    const meta = JSON.parse(await fs.readFile(path.join(storyDir, 'metadata.json'), 'utf8'));
    return {
      id: storyId,
      headline: headline || meta.headline || meta.title || storyId,
      subtitle: subtitle || meta.subtitle || '',
      thumbUrl: thumbUrl || (meta.thumbnail ? `/static/${storyId}/${meta.thumbnail}` : ''),
    };
  } catch {
    return { id: storyId, headline: headline || storyId, subtitle: subtitle || '', thumbUrl };
  }
}

const uploadMem = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 200 * 1024 * 1024 }, // 200 MB
});

function requireKey(req, res) {
  const k = req.header('x-soapbox-key') || '';
  if (!SOAPBOX_KEY || k !== SOAPBOX_KEY) {
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }
  return true;
}

// ---------- Routes: Stories (local) ----------
app.get('/stories', async (_req, res) => {
  try {
    const entries = await fs.readdir(STORIES_DIR, { withFileTypes: true });
    const dirs = entries.filter(d => d.isDirectory()).map(d => d.name);
    const out = [];
    for (const storyId of dirs) {
      const storyDir = path.join(STORIES_DIR, storyId);
      out.push(await readStoryPresentation(storyDir, storyId));
    }
    res.json(out);
  } catch (e) {
    console.error('Error reading stories:', e);
    res.status(500).json({ error: 'Failed to read stories' });
  }
});

// ---------- Routes: Witness upload -> S3 ----------
app.get(['/witness/ping','/api/witness/ping'], (req,res) => {
  if (!requireKey(req,res)) return;
  res.json({ ok: true });
});

app.post(['/witness','/api/witness'], uploadMem.single('video'), async (req,res) => {
  try {
    if (!requireKey(req,res)) return;
    if (!S3_BUCKET) return res.status(500).json({ error: 'S3 bucket not configured' });
    if (!req.file)   return res.status(400).json({ error: 'video file required' });

    const { storyId, storyTitle } = req.body || {};
    if (!storyId) return res.status(400).json({ error: 'storyId required' });

    const cleanId    = sanitize(storyId);
    const cleanTitle = sanitize(storyTitle) || cleanId;

    const ext   = pickExt(req.file.originalname, req.file.mimetype);
    const stamp = new Date().toISOString().replace(/[:.]/g, '').replace('T','_').slice(0,15);
    const rand  = crypto.randomBytes(3).toString('hex');

    const key = `stories/${cleanId}/witnesses/${stamp}_${rand}_${cleanTitle}${ext}`;

    await s3.send(new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: key,
      Body: req.file.buffer,
      ContentType: req.file.mimetype || 'application/octet-stream',
    }));

    res.json({ ok: true, bucket: S3_BUCKET, key, size: req.file.size });
  } catch (e) {
    console.error('[witness->s3] upload error:', e);
    res.status(500).json({ error: 'Upload failed' });
  }
});

// ---------- NEW: Links JSON from S3 ----------
app.get('/links', async (_req, res) => {
  try {
    if (!S3_BUCKET) return res.json({ items: [] }); // safe fallback
    const r = await s3.send(new GetObjectCommand({
      Bucket: S3_BUCKET,
      Key: 'links/links.json',
    }));
    const text = await r.Body.transformToString(); // Node 18+
    res.setHeader('Cache-Control', 'no-store');
    res.type('application/json').send(text);
  } catch (e) {
    console.error('/links error:', e?.message || e);
    res.json({ items: [] }); // fallback
  }
});

// ---------- NEW: Static proxy from S3 (images etc.) ----------
// e.g. GET /static-s3/links/youtube.png -> S3 key "links/youtube.png"
app.get('/static-s3/*', async (req, res) => {
  try {
    if (!S3_BUCKET) return res.status(404).send('Not found');
    const key = req.params[0]; // everything after /static-s3/
    const r = await s3.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: key }));
    if (r.ContentType) res.setHeader('Content-Type', r.ContentType);
    res.setHeader('Cache-Control', 'no-store');
    r.Body.pipe(res);
  } catch (e) {
    res.status(404).send('Not found');
  }
});

// ---------- Health + errors ----------
app.get('/health', (_req,res)=> res.json({ ok: true }));
app.use((_req,res)=> res.status(404).json({ error: 'Not found' }));
app.use((err,_req,res,_next)=> {
  console.error('API error:', err);
  res.status(err.status||500).json({ error: err.message || 'Server error' });
});

// ---------- Start ----------
const PORT = Number(process.env.PORT) || 3030;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`API listening on :${PORT}`);
});

try {
  require('./bot');
  console.log('✅ Discord bot started');
} catch (e) {
  console.error('❌ Bot start failed:', e);
}
