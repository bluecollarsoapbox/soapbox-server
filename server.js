// server.js — Blue Collar Soapbox API (S3-backed stories + spotlights + confessions + witness upload)
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const multer = require('multer');
const fetch = require('node-fetch'); // v2
const {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
  PutObjectCommand,
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const app = express();
app.disable('x-powered-by');
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ---------- ENV ----------
const PORT = Number(process.env.PORT || 3030);
const SOAPBOX_KEY = process.env.SOAPBOX_API_KEY || process.env.API_KEY || '';
const S3_BUCKET = process.env.S3_BUCKET;
const S3_REGION = process.env.AWS_REGION || process.env.S3_REGION || 'us-east-2';
const DISCORD_CONFESSIONS_WEBHOOK = process.env.DISCORD_CONFESSIONS_WEBHOOK || '';
const DISCORD_SPOTLIGHTS_WEBHOOK = process.env.DISCORD_SPOTLIGHTS_WEBHOOK || '';

if (!S3_BUCKET) console.warn('[WARN] S3_BUCKET not set');
const s3 = new S3Client({ region: S3_REGION });

// ---------- Helpers ----------
const mustKey = (req, res) => {
  const k = req.header('x-soapbox-key') || '';
  if (!SOAPBOX_KEY || k !== SOAPBOX_KEY) {
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }
  return true;
};
const sanitize = (s) =>
  String(s || '').replace(/[^\w\-\s.]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80);

async function listStoryPrefixes() {
  // List "directories" under stories/
  const cmd = new ListObjectsV2Command({
    Bucket: S3_BUCKET,
    Prefix: 'stories/',
    Delimiter: '/',
  });
  const out = await s3.send(cmd);
  // CommonPrefixes like: stories/Story1/
  return (out.CommonPrefixes || [])
    .map((p) => p.Prefix)
    .filter((p) => /^stories\/Story\d+\/$/i.test(p));
}

async function signUrl(Key, expiresSec = 3600) {
  return await getSignedUrl(s3, new GetObjectCommand({ Bucket: S3_BUCKET, Key }), { expiresIn: expiresSec });
}

async function tryGetJson(Key) {
  try {
    const url = await signUrl(Key, 60);
    const r = await fetch(url);
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

async function buildStory(storyPrefix) {
  // storyPrefix like: "stories/Story1/"
  const storyId = storyPrefix.split('/').filter(Boolean).pop(); // "Story1"
  const meta = (await tryGetJson(`${storyPrefix}metadata.json`)) || {};
  // thumbs: prefer YouTube thumb (you uploaded as "<name> YT.png"), fall back to any thumb
  const thumbCandidates = [
    `${storyPrefix}thumbYT.jpg`,
    `${storyPrefix}thumbYT.png`,
    `${storyPrefix}thumb.jpg`,
    `${storyPrefix}thumb.png`,
  ];

  let thumbUrl = '';
  for (const key of thumbCandidates) {
    try {
      thumbUrl = await signUrl(key, 3600);
      break;
    } catch {}
  }

  // voicemail (mp4) — if present, return newest signed URL
  let voicemailUrl = '';
  try {
    const list = await s3.send(
      new ListObjectsV2Command({ Bucket: S3_BUCKET, Prefix: `${storyPrefix}voicemails/` })
    );
    const items = (list.Contents || []).filter((o) => /\.mp4$/i.test(o.Key));
    items.sort((a, b) => (b.LastModified?.getTime() || 0) - (a.LastModified?.getTime() || 0));
    if (items[0]) voicemailUrl = await signUrl(items[0].Key, 3600);
  } catch {}

  return {
    id: storyId,
    headline: meta.headline || meta.title || storyId,
    subtitle: meta.subtitle || '',
    youtubeId: meta.youtubeId || '',
    thumbUrl: thumbUrl || '',
    voicemailUrl,
  };
}

// ---------- Routes ----------

// Health
app.get('/health', (_req, res) => res.json({ ok: true }));

// Stories (S3 → signed URLs + metadata.json)
app.get('/stories', async (_req, res) => {
  try {
    const prefixes = await listStoryPrefixes(); // [ 'stories/Story1/', ... ]
    const stories = await Promise.all(prefixes.map(buildStory));
    // sort StoryN ascending by N
    stories.sort((a, b) => {
      const na = Number(a.id.replace(/\D/g, '')) || 0;
      const nb = Number(b.id.replace(/\D/g, '')) || 0;
      return na - nb;
    });
    res.json(stories);
  } catch (e) {
    console.error('[stories] error:', e);
    res.status(500).json({ error: 'Failed to list stories' });
  }
});

// Witness upload (kept from before) — expects multipart "video", fields: storyId, storyTitle
const uploadMem = multer({ storage: multer.memoryStorage(), limits: { fileSize: 200 * 1024 * 1024 } });
app.post(['/witness', '/api/witness'], uploadMem.single('video'), async (req, res) => {
  try {
    if (!mustKey(req, res)) return;
    if (!S3_BUCKET) return res.status(500).json({ error: 'S3 bucket not configured' });
    if (!req.file) return res.status(400).json({ error: 'video file required' });

    const { storyId, storyTitle } = req.body || {};
    if (!storyId) return res.status(400).json({ error: 'storyId required' });

    const cleanId = sanitize(storyId);
    const cleanTitle = sanitize(storyTitle) || cleanId;
    const ext = (req.file.originalname?.match(/\.\w+$/)?.[0] || '.mp4').toLowerCase();
    const stamp = new Date().toISOString().replace(/[:.]/g, '').replace('T', '_').slice(0, 15);
    const rand = crypto.randomBytes(3).toString('hex');

    const key = `stories/${cleanId}/witnesses/${stamp}_${rand}_${cleanTitle}${ext}`;
    await s3.send(
      new PutObjectCommand({
        Bucket: S3_BUCKET,
        Key: key,
        Body: req.file.buffer,
        ContentType: req.file.mimetype || 'application/octet-stream',
      })
    );

    res.json({ ok: true, bucket: S3_BUCKET, key, size: req.file.size });
  } catch (e) {
    console.error('[witness->s3] upload error:', e);
    res.status(500).json({ error: 'Upload failed' });
  }
});

// Confessions → Discord webhook
app.post('/confessions', async (req, res) => {
  try {
    const { text } = req.body || {};
    if (!text || String(text).trim().length < 3) {
      return res.status(400).json({ error: 'confession text required' });
    }
    if (!DISCORD_CONFESSIONS_WEBHOOK) return res.status(500).json({ error: 'webhook not configured' });

    const r = await fetch(DISCORD_CONFESSIONS_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: `🗣️ **Confession**\n${text}` }),
    });
    if (!r.ok) throw new Error(`discord ${r.status}`);
    res.json({ ok: true });
  } catch (e) {
    console.error('[confessions] error:', e);
    res.status(500).json({ error: 'Failed to post confession' });
  }
});

// Spotlights submission → Discord webhook
app.post('/spotlights', async (req, res) => {
  try {
    const { name, link, notes } = req.body || {};
    if (!name || !link) return res.status(400).json({ error: 'name and link required' });
    if (!DISCORD_SPOTLIGHTS_WEBHOOK) return res.status(500).json({ error: 'webhook not configured' });

    const content = [
      '🔦 **New Spotlight Submission**',
      `**Name:** ${name}`,
      `**Link:** ${link}`,
      notes ? `**Notes:** ${notes}` : null,
    ]
      .filter(Boolean)
      .join('\n');

    const r = await fetch(DISCORD_SPOTLIGHTS_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    });
    if (!r.ok) throw new Error(`discord ${r.status}`);
    res.json({ ok: true });
  } catch (e) {
    console.error('[spotlights] error:', e);
    res.status(500).json({ error: 'Failed to submit spotlight' });
  }
});

// Fallbacks
app.use((_req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, _req, res, _next) => {
  console.error('API error:', err);
  res.status(err.status || 500).json({ error: err.message || 'Server error' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`API listening on :${PORT}`);
});
