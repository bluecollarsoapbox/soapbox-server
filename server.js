// server.js — Blue Collar Soapbox API (Render-safe, no morgan)

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();

// ---------- Core settings & middleware ----------
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(cors());
app.options('*', cors()); // handle preflight properly
// Use one set of body parsers (avoid duplicates)
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Mount the S3 witness route (exposes POST /api/witness)
app.use(require('./routes/witness-s3'));

// ---------- Paths / dirs ----------
const ROOT = __dirname;

// IMPORTANT: default to Render's persistent, writable path
const DATA_DIR =
  (process.env.DATA_DIR && process.env.DATA_DIR.trim()) ||
  '/opt/render/project/data';

// Keep your original content roots, but fall back to DATA_DIR subfolders so it's writeable on Render
const STORIES_DIR     = process.env.STORIES_ROOT       || path.join(DATA_DIR, 'Stories');
const SPOTLIGHTS_DIR  = process.env.SPOTLIGHT_FEED_DIR || path.join(DATA_DIR, 'Spotlights');
const CONFESSIONS_DIR = process.env.CONFESSIONS_DIR    || path.join(DATA_DIR, 'Confessions');
const VOICEMAILS_DIR  = process.env.VOICEMAILS_DIR     || path.join(DATA_DIR, 'Voicemails For Discord');

// Ensure the base data dir exists
fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------- Helpers ----------
const readJSON = (file, fallback = []) => {
  try {
    if (!fs.existsSync(file)) return fallback;
    const raw = fs.readFileSync(file, 'utf8');
    return JSON.parse(raw || '[]');
  } catch (e) {
    console.error('JSON read error:', file, e.message);
    return fallback;
  }
};

const listAudioFiles = (dir) => {
  if (!fs.existsSync(dir)) return [];
  const exts = new Set(['.mp3', '.wav', '.m4a', '.aac', '.ogg']);
  return fs
    .readdirSync(dir)
    .filter((f) => exts.has(path.extname(f).toLowerCase()))
    .map((filename) => {
      // Stable, non-reversible id
      const id = crypto.createHash('sha1').update(filename).digest('hex');
      const full = path.join(dir, filename);
      const stat = fs.statSync(full);
      return {
        id, // used for streaming
        size: stat.size,
        createdAt: (stat.mtime || stat.ctime || new Date()).toISOString(),
        ext: path.extname(filename).toLowerCase().slice(1),
      };
    });
};

const guessMime = (ext) => {
  switch (ext.toLowerCase()) {
    case '.mp3': return 'audio/mpeg';
    case '.wav': return 'audio/wav';
    case '.m4a': return 'audio/mp4';
    case '.aac': return 'audio/aac';
    case '.ogg': return 'audio/ogg';
    default: return 'application/octet-stream';
  }
};

const buildVoicemailIndex = () => {
  const files = fs.existsSync(VOICEMAILS_DIR) ? fs.readdirSync(VOICEMAILS_DIR) : [];
  const map = new Map();
  for (const f of files) {
    const ext = path.extname(f).toLowerCase();
    if (!['.mp3', '.wav', '.m4a', '.aac', '.ogg'].includes(ext)) continue;
    const id = crypto.createHash('sha1').update(f).digest('hex');
    map.set(id, path.join(VOICEMAILS_DIR, f));
  }
  return map;
};

// ---------- Health ----------
app.get('/health', (_req, res) => res.status(200).json({ ok: true }));

// ---------- Stories ----------
app.get('/stories', (_req, res) => {
  const file = path.join(STORIES_DIR, 'metadata.json');
  const data = readJSON(file, []);
  res.json(Array.isArray(data) ? data : []);
});

// ---------- Spotlights ----------
app.get('/spotlights', (_req, res) => {
  const file = path.join(SPOTLIGHTS_DIR, 'metadata.json');
  const data = readJSON(file, []);
  res.json(Array.isArray(data) ? data : []);
});

// ---------- Confessions ----------
app.get('/confessions', (_req, res) => {
  const file = path.join(CONFESSIONS_DIR, 'metadata.json');
  const data = readJSON(file, []);
  res.json(Array.isArray(data) ? data : []);
});

// Queue a new confession to disk (no auth by default)
app.post('/confessions', (req, res) => {
  const { text } = req.body || {};
  if (!text || typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ error: 'Text is required' });
  }
  const queueDir = path.join(DATA_DIR, 'confessions-queue');
  fs.mkdirSync(queueDir, { recursive: true });
  const id = Date.now() + '-' + crypto.randomBytes(4).toString('hex');
  const payload = { id, text: text.trim(), createdAt: new Date().toISOString(), ip: req.ip };
  fs.writeFileSync(path.join(queueDir, id + '.json'), JSON.stringify(payload, null, 2));
  res.json({ ok: true, id });
});

// ---------- Voicemails ----------
app.get('/voicemails', (_req, res) => {
  try {
    const list = listAudioFiles(VOICEMAILS_DIR);
    res.json(list);
  } catch (e) {
    console.error('voicemails list error:', e);
    res.json([]);
  }
});

// Stream by id (never reveals real filenames)
app.get('/voicemails/:id/stream', (req, res) => {
  const index = buildVoicemailIndex();
  const filePath = index.get(req.params.id);
  if (!filePath) return res.status(404).json({ error: 'Not found' });

  const stat = fs.statSync(filePath);
  const total = stat.size;
  const ext = path.extname(filePath);
  const mime = guessMime(ext);

  res.setHeader('Content-Type', mime);
  res.setHeader('Content-Disposition', `inline; filename="voicemail${ext}"`);
  res.setHeader('Accept-Ranges', 'bytes');

  const range = req.headers.range;
  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : total - 1;
    if (isNaN(start) || isNaN(end) || start > end || end >= total) {
      return res.status(416).set('Content-Range', `bytes */${total}`).end();
    }
    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`);
    res.setHeader('Content-Length', end - start + 1);
    fs.createReadStream(filePath, { start, end }).pipe(res);
  } else {
    res.setHeader('Content-Length', total);
    fs.createReadStream(filePath).pipe(res);
  }
});

// ---------- Root ----------
app.get('/', (_req, res) => res.type('text').send('Blue Collar Soapbox API running.'));

// ---------- 404 & Error ----------
app.use((_req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, _req, res, _next) => {
  console.error('API error:', err);
  res.status(err.status || 500).json({ error: err.message || 'Server error' });
});

// ---------- Start ----------
const PORT = Number(process.env.PORT) || 3030;
const HOST = '0.0.0.0';
app.listen(PORT, HOST, () => {
  console.log(`[BOOT] DATA_DIR=${DATA_DIR}`);
  console.log(`API listening on http://${HOST}:${PORT}`);
});
