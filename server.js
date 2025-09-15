// server.js — robust stories + witness API
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs/promises');
const fssync = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

// ---------- App ----------
const app = express();
app.disable('x-powered-by');
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ---------- Paths ----------
/**
 * DATA_DIR lets us store Stories on a persistent disk on Render (eg. /data).
 * Falls back to the local repo folder "Stories".
 */
const ROOT_DATA = process.env.DATA_DIR || path.join(__dirname);
const STORIES_DIR = path.join(ROOT_DATA, 'Stories');

// serve everything under Stories as static (thumbs, witness uploads, etc.)
app.use('/static', express.static(STORIES_DIR, { fallthrough: true }));

// ---------- Config ----------
const SOAPBOX_KEY = process.env.SOAPBOX_API_KEY || process.env.API_KEY || '';
const S3_BUCKET = process.env.S3_BUCKET;
const S3_REGION = process.env.AWS_REGION || 'us-east-2';
const s3 = new S3Client({ region: S3_REGION });

// ---------- Helpers ----------
const existsSync = (p) => { try { fssync.accessSync(p); return true; } catch { return false; } };
const safeRead = async (p) => { try { return (await fs.readFile(p, 'utf8')).trim(); } catch { return ''; } };
const sanitize = (s) =>
  String(s || '').replace(/[^\w\-\s.]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80);

const pickExt = (original, mimetype) => {
  const ext = path.extname(original || '').toLowerCase();
  if (ext) return ext;
  if (/quicktime/i.test(mimetype)) return '.mov';
  if (/mp4/i.test(mimetype)) return '.mp4';
  return '.mp4';
};

/** case-insensitive file lookup */
function findCaseInsensitive(dir, filenames) {
  const set = new Map();
  try {
    for (const n of fssync.readdirSync(dir)) set.set(n.toLowerCase(), n);
  } catch { /* ignore */ }
  for (const want of filenames) {
    const hit = set.get(want.toLowerCase());
    if (hit) return path.join(dir, hit);
  }
  return null;
}

async function readJSONLenient(filePath) {
  if (!filePath) return null;
  try {
    // try strict JSON
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch {
    // try JSON5 if present in deps; otherwise attempt a quick nuke of comments
    try {
      const json5 = require('json5');
      return json5.parse(await fs.readFile(filePath, 'utf8'));
    } catch {
      try {
        const raw = await fs.readFile(filePath, 'utf8');
        const noComments = raw
          .replace(/^\s*\/\/.*$/gm, '')
          .replace(/\/\*[\s\S]*?\*\//g, '');
        return JSON.parse(noComments);
      } catch { return null; }
    }
  }
}

function makeStaticUrl(storyId, basename) {
  if (!basename) return '';
  const full = path.join(STORIES_DIR, storyId, basename);
  let v = '';
  try { v = (fssync.statSync(full).mtimeMs | 0).toString(); } catch {}
  const enc = (s) => encodeURIComponent(s);
  return `/static/${enc(storyId)}/${enc(basename)}${v ? `?v=${v}` : ''}`;
}

async function readStoryPresentation(storyDirName) {
  const storyDir = path.join(STORIES_DIR, storyDirName);

  // headline/subtitle text (case-insensitive)
  const headlineTxt = findCaseInsensitive(storyDir, ['headline.txt']);
  const subtitleTxt = findCaseInsensitive(storyDir, ['subtitle.txt']);
  const headline = await safeRead(headlineTxt || '');
  const subtitle = await safeRead(subtitleTxt || '');

  // metadata: metadata.json or metadata.json5 (any casing)
  const metaFile = findCaseInsensitive(storyDir, ['metadata.json', 'metadata.json5']);
  const meta = await readJSONLenient(metaFile);

  // thumbnail candidates (case-insensitive search)
  const thumbFile =
    findCaseInsensitive(storyDir, [
      'thumbYT.jpg','thumbYT.png',
      'thumb.jpg','thumb.png',
      'thumbnail.jpg','thumbnail.png'
    ]) ||
    (meta && meta.thumbnail ? path.join(storyDir, meta.thumbnail) : null);

  const thumbUrl = thumbFile
    ? makeStaticUrl(storyDirName, path.basename(thumbFile))
    : '';

  return {
    id: storyDirName,                                 // folder name (e.g. Story5)
    headline: headline || (meta && (meta.headline || meta.title)) || storyDirName,
    subtitle: subtitle || (meta && meta.subtitle) || '',
    thumbUrl,
  };
}

// ---------- Routes ----------
app.get('/stories', async (_req, res) => {
  try {
    const entries = await fs.readdir(STORIES_DIR, { withFileTypes: true });
    const dirs = entries.filter(d => d.isDirectory()).map(d => d.name);

    // Sort by folder name natural-ish: Story1, Story2, … Story10
    dirs.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));

    const out = [];
    for (const storyId of dirs) out.push(await readStoryPresentation(storyId));
    res.json(out);
  } catch (e) {
    console.error('Error reading stories:', e);
    res.status(500).json({ error: 'Failed to read stories' });
  }
});

app.get(['/witness/ping','/api/witness/ping'], (req,res) => {
  const k = req.header('x-soapbox-key') || '';
  if (!SOAPBOX_KEY || k !== SOAPBOX_KEY) return res.status(401).json({ error: 'Unauthorized' });
  res.json({ ok:true });
});

const uploadMem = multer({ storage: multer.memoryStorage(), limits: { fileSize: 200 * 1024 * 1024 } });

app.post(['/witness','/api/witness'], uploadMem.single('video'), async (req,res) => {
  try {
    const k = req.header('x-soapbox-key') || '';
    if (!SOAPBOX_KEY || k !== SOAPBOX_KEY) return res.status(401).json({ error: 'Unauthorized' });
    if (!S3_BUCKET) return res.status(500).json({ error: 'S3 bucket not configured' });
    if (!req.file)   return res.status(400).json({ error: 'video file required' });

    const { storyId, storyTitle } = req.body || {};
    if (!storyId) return res.status(400).json({ error: 'storyId required' });

    const cleanId    = sanitize(storyId);
    const cleanTitle = sanitize(storyTitle) || cleanId;
    const ext   = pickExt(req.file.originalname, req.file.mimetype);
    const stamp = new Date().toISOString().replace(/[:.]/g, '').replace('T','_').slice(0,15);
    const rand  = crypto.randomBytes(3).toString('hex');
    const key   = `stories/${cleanId}/witnesses/${stamp}_${rand}_${cleanTitle}${ext}`;

    await s3.send(new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: key,
      Body: req.file.buffer,
      ContentType: req.file.mimetype || 'application/octet-stream',
    }));

    res.json({ ok:true, bucket:S3_BUCKET, key, size:req.file.size });
  } catch (e) {
    console.error('[witness->s3] upload error:', e);
    res.status(500).json({ error: 'Upload failed' });
  }
});

// health + fallback
app.get('/health', (_req,res)=> res.json({ ok:true, storiesDir: STORIES_DIR }));
app.use((_req,res)=> res.status(404).json({ error:'Not found' }));

// start
const PORT = Number(process.env.PORT) || 3030;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`API listening on :${PORT} (Stories at ${STORIES_DIR})`);
});

// start the bot (optional)
try {
  require('./bot');
  console.log('✅ Discord bot started');
} catch (e) {
  console.error('❌ Bot start failed:', e.message || e);
}
