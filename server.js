// server.js — Blue Collar Soapbox API
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();

// ---------- Core middleware ----------
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

// ---------- Mount routes ----------
app.use('/api', require('./routes/witness-s3'));   // <— /api/witness is now guaranteed

// ---------- Data roots (kept from your version) ----------
const DATA_DIR = (process.env.DATA_DIR && process.env.DATA_DIR.trim())
  ? process.env.DATA_DIR.trim()
  : '/opt/render/project/data';

const STORIES_DIR     = process.env.STORIES_ROOT       || path.join(DATA_DIR, 'Stories');
const SPOTLIGHTS_DIR  = process.env.SPOTLIGHT_FEED_DIR || path.join(DATA_DIR, 'Spotlights');
const CONFESSIONS_DIR = process.env.CONFESSIONS_DIR    || path.join(DATA_DIR, 'Confessions');
const VOICEMAILS_DIR  = process.env.VOICEMAILS_DIR     || path.join(DATA_DIR, 'Voicemails For Discord');

fs.mkdirSync(DATA_DIR, { recursive: true });

const readJSON = (file, fallback = []) => {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8') || '[]');
  } catch (e) {
    console.error('JSON read error:', file, e.message);
    return fallback;
  }
};

const listAudioFiles = (dir) => {
  if (!fs.existsSync(dir)) return [];
  const exts = new Set(['.mp3', '.wav', '.m4a', '.aac', '.ogg']);
  return fs.readdirSync(dir).filter(f => exts.has(path.extname(f).toLowerCase()))
    .map(filename => {
      const id = crypto.createHash('sha1').update(filename).digest('hex');
      const full = path.join(dir, filename);
      const stat = fs.statSync(full);
      return { id, size: stat.size, createdAt: (stat.mtime || stat.ctime).toISOString(), ext: path.extname(filename).slice(1) };
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

// ---------- Stories / Spotlights / Confessions ----------
app.get('/stories',   (_req, res) => res.json(readJSON(path.join(STORIES_DIR, 'metadata.json'), [])));
app.get('/spotlights',(_req, res) => res.json(readJSON(path.join(SPOTLIGHTS_DIR, 'metadata.json'), [])));
app.get('/confessions',(_req, res) => res.json(readJSON(path.join(CONFESSIONS_DIR, 'metadata.json'), [])));

app.post('/confessions', (req, res) => {
  const { text } = req.body || {};
  if (!text || !String(text).trim()) return res.status(400).json({ error: 'Text is required' });
  const queueDir = path.join(DATA_DIR, 'confessions-queue');
  fs.mkdirSync(queueDir, { recursive: true });
  const id = Date.now() + '-' + crypto.randomBytes(4).toString('hex');
  const payload = { id, text: String(text).trim(), createdAt: new Date().toISOString(), ip: req.ip };
  fs.writeFileSync(path.join(queueDir, id + '.json'), JSON.stringify(payload, null, 2));
  res.json({ ok: true, id });
});

// ---------- Voicemails ----------
app.get('/voicemails', (_req, res) => res.json(listAudioFiles(VOICEMAILS_DIR)));

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

// ---------- Root / 404 / Error ----------
app.get('/', (_req, res) => res.type('text').send('Blue Collar Soapbox API running.'));

app.use((_req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, _req, res, _next) => {
  console.error('API error:', err);
  res.status(err.status || 500).json({ error: err.message || 'Server error' });
});

// ---------- Start ----------
const PORT = Number(process.env.PORT) || 3030;
const HOST = '0.0.0.0';
app.listen(PORT, HOST, () => {
  console.log(`API listening on http://${HOST}:${PORT}`);
});
