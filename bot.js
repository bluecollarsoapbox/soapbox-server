// ===================== Soapbox Discord Bot (stories + confessions + witness via S3) =====================
require('dotenv').config();

// ---- fetch (Node 18+ has global.fetch; older Node needs node-fetch) ----
let _fetch = global.fetch;
if (!_fetch) {
  _fetch = (...args) => import('node-fetch').then(m => m.default(...args));
}
const fetch = (...args) => _fetch(...args);

const fs   = require('fs');
const os   = require('os');
const fsp  = require('fs/promises');
const path = require('path');

const express = require('express');
const cors    = require('cors');
const multer  = require('multer');

const {
  Client,
  GatewayIntentBits,
  AttachmentBuilder,
  ChannelType,
} = require('discord.js');

// ---------- S3 (for witness uploads) ----------
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const crypto = require('crypto');
const S3_BUCKET = process.env.S3_BUCKET || '';
const S3_REGION = process.env.AWS_REGION || 'us-east-2';
const s3 = new S3Client({ region: S3_REGION }); // expects AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY in env

// ---------- Secrets ----------
function getDiscordToken() {
  const fromEnv = (process.env.DISCORD_TOKEN || '').trim();
  if (fromEnv) return fromEnv;
  try { return fs.readFileSync('/etc/secrets/DISCORD_TOKEN', 'utf8').trim(); } catch {}
  try { return fs.readFileSync('/etc/secrets/discord_token', 'utf8').trim(); } catch {}
  return '';
}
const TOKEN = getDiscordToken();
if (!TOKEN) {
  console.error('❌ DISCORD_TOKEN is empty or missing. Set env var or Secret File /etc/secrets/DISCORD_TOKEN.');
  process.exit(1);
}
console.log('[ENV] DISCORD_TOKEN length:', TOKEN.length);

// API key for protected routes
const API_KEY = (process.env.SOAPBOX_API_KEY || '99dnfneeekdegnrJJSN3JdenrsdnJ').trim();

// Optional public API base to build voicemail links
const PUBLIC_API_BASE = (process.env.PUBLIC_API_BASE || process.env.API_BASE_URL || '').trim();

// ---------- Discord channels ----------
const VOICEMAIL_CHANNEL_ID   = '1407177470997696562';
const CONFESSIONS_CHANNEL_ID = '1407177292605685932';
const BREAKING_CHANNEL_ID    = '1407176815285637313';

// Private intake channel for Spotlight (optional)
const SPOTLIGHT_CHANNEL_ID = '1411392998427856907';

// ---------- Paths / Storage ----------
const API_PORT = process.env.PORT ? Number(process.env.PORT) : 10000;

// Prefer Render’s persistent disk; otherwise Windows dev path
const RENDER_DATA = '/opt/render/project/data';
const LINUX_DATA  = fs.existsSync(RENDER_DATA) ? RENDER_DATA : null;
const WIN_ROOT    = 'D:\\Soapbox App';

// Base data
const DATA_DIR = process.env.DATA_DIR
  || (LINUX_DATA ? path.join(LINUX_DATA) : path.join(WIN_ROOT, 'data'));

// Spotlights folder
const SPOTLIGHT_FEED_DIR = process.env.SPOTLIGHT_FEED_DIR
  || (LINUX_DATA ? path.join(LINUX_DATA, 'Spotlights') : path.join(WIN_ROOT, 'Spotlights'));

// Stories root (Story1..Story5)
const STORIES_ROOT = process.env.STORIES_ROOT
  || (LINUX_DATA ? path.join(LINUX_DATA, 'Stories') : path.join(WIN_ROOT, 'Stories'));

// Optional voicemail drop watcher dir (usually unset on Render)
const WATCH_DIR = process.env.WATCH_DIR || '';

// JSON state files
const CONF_JSON           = path.join(DATA_DIR, 'confessions.json');
const SPOTLIGHT_JSON      = path.join(DATA_DIR, 'spotlight.json');
const STORY_SYNC          = path.join(DATA_DIR, 'stories-sync.json');
const SPOTLIGHT_FEED_JSON = path.join(DATA_DIR, 'spotlight-feed.json'); // legacy

// ---------- File rules ----------
const AUDIO_EXTS   = new Set(['.mp3', '.m4a', '.ogg', '.wav']);
const VIDEO_RE     = /\.(mp4|mov|mkv|webm|avi)$/i;
const IMAGE_RE     = /\.(jpg|jpeg|png|webp)$/i;
const SAFE_NAME_RE = /^Voicemail_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}(?:_\d+)?\.(mp3|m4a|ogg|wav)$/i;

const SETTLE_MS     = 800;
const SETTLE_ROUNDS = 3;

// ---------- Discord client ----------
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
});

console.log('[PATHS]',
  'DATA_DIR=', DATA_DIR,
  'STORIES_ROOT=', STORIES_ROOT,
  'SPOTLIGHT_FEED_DIR=', SPOTLIGHT_FEED_DIR
);

// ===================== helpers =====================
const pad = (n) => String(n).padStart(2, '0');
const isAudio = (p) => AUDIO_EXTS.has(path.extname(p).toLowerCase());

function tsBase(d = new Date()) {
  return `Voicemail_${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}
function stamp() {
  const d = new Date();
  return `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

async function waitForSettle(fp){
  let same = 0, prev = { size: -1, mtimeMs: -1 };
  while (same < SETTLE_ROUNDS) {
    await new Promise(r => setTimeout(r, SETTLE_MS));
    try {
      const s = await fsp.stat(fp);
      const cur = { size: s.size, mtimeMs: s.mtimeMs };
      if (cur.size === prev.size && cur.mtimeMs === prev.mtimeMs) same++;
      else { same = 0; prev = cur; }
    } catch { same = 0; }
  }
}
async function renameSafe(oldFull){
  const dir = path.dirname(oldFull);
  const ext = path.extname(oldFull).toLowerCase();
  let base = tsBase() + ext;
  let out  = path.join(dir, base);
  let i = 1;
  while (fs.existsSync(out)) {
    base = tsBase() + `_${i++}` + ext;
    out  = path.join(dir, base);
  }
  await fsp.rename(oldFull, out);
  return out;
}

async function postVoicemail(filePath) {
  const ch = await client.channels.fetch(VOICEMAIL_CHANNEL_ID);
  const att = new AttachmentBuilder(filePath);
  await ch.send({ content: `📢 **New Hotline Voicemail (323-743-3744)**`, files: [att] });
  console.log('✅ Posted voicemail:', path.basename(filePath));
}

function ensureData(){
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(CONF_JSON)) fs.writeFileSync(CONF_JSON, '[]');
  if (!fs.existsSync(STORIES_ROOT)) fs.mkdirSync(STORIES_ROOT, { recursive: true });
  if (!fs.existsSync(SPOTLIGHT_JSON)) fs.writeFileSync(SPOTLIGHT_JSON, '[]');
  if (!fs.existsSync(SPOTLIGHT_FEED_DIR)) fs.mkdirSync(SPOTLIGHT_FEED_DIR, { recursive: true });

  if (WATCH_DIR) {
    try { fs.mkdirSync(WATCH_DIR, { recursive: true }); }
    catch (e) { console.warn('Could not create WATCH_DIR:', WATCH_DIR, e?.message || e); }
  }
}

function readJSONSafe(fp, fallback){ try { return JSON.parse(fs.readFileSync(fp,'utf8')); } catch { return fallback; } }
function readTextSafe(fp){ try { return fs.readFileSync(fp,'utf8').trim(); } catch { return ''; } }

function getLocalIp(){
  const ifs = os.networkInterfaces();
  for (const name of Object.keys(ifs)) for (const net of ifs[name] || []) {
    if (net.family === 'IPv4' && !net.internal) return net.address;
  }
  return 'localhost';
}

function authOk(req){
  const sent = (req.headers['x-soapbox-key'] || req.query.key || '').toString().trim();
  const expect = (API_KEY || '').toString().trim();
  return sent && sent === expect;
}

const ensureDir = (p) => { if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }); };

function storyFolder(storyId){ return path.join(STORIES_ROOT, storyId); }
function voicemailFolder(storyId){ return path.join(storyFolder(storyId), 'voicemail'); }
function witnessFolder(storyId){ return path.join(storyFolder(storyId), 'witnesses'); }

function newestMTimeOf(dir) {
  try {
    const items = fs.readdirSync(dir);
    let newest = 0;
    for (const f of items) {
      const full = path.join(dir, f);
      const s = fs.statSync(full);
      const t = s.mtimeMs || s.ctimeMs || 0;
      if (t > newest) newest = t;
    }
    return newest || Date.now();
  } catch { return Date.now(); }
}

function firstVoicemailFile(storyId){
  const dir = voicemailFolder(storyId);
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir)
    .filter(f => isAudio(f))
    .map(f => path.join(dir, f))
    .sort((a,b)=> fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return files[0] || null;
}

// --- witness index helpers for in-app feed (still local JSON alongside StoryN) ---
function readJsonSafe(p, fallback) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; } }
function writeJsonSafe(p, obj) { fs.writeFileSync(p, JSON.stringify(obj, null, 2)); }
function storyDir(storyId) { return path.join(STORIES_ROOT, storyId); }
function witnessIndexPath(storyId) { return path.join(storyDir(storyId), 'witnesses.json'); }
function loadWitnesses(storyId) { return readJsonSafe(witnessIndexPath(storyId), []); }
function saveWitnesses(storyId, list) { writeJsonSafe(witnessIndexPath(storyId), list); }
function newId() { return Math.random().toString(36).slice(2) + Date.now().toString(36); }

// --- Story sync log (prevents reposting the same cycle) ---
function readStorySync(){ try { return JSON.parse(fs.readFileSync(STORY_SYNC,'utf8')); } catch { return {}; } }
function writeStorySync(obj){ fs.writeFileSync(STORY_SYNC, JSON.stringify(obj, null, 2)); }

function fileMtimeMsSafe(p){ try{ return fs.statSync(p).mtimeMs|0; }catch{ return 0; } }
function newestMtimeInDir(dir, filterFn=null){
  try{
    const names = fs.readdirSync(dir);
    let newest = 0;
    for(const n of names){
      if (filterFn && !filterFn(n)) continue;
      const t = fileMtimeMsSafe(path.join(dir,n));
      if (t > newest) newest = t;
    }
    return newest;
  }catch{ return 0; }
}

function getStoryCycleKey(storyId){
  const dir   = storyFolder(storyId);
  const meta  = path.join(dir, 'metadata.json');
  const head  = path.join(dir, 'headline.txt');
  const sub   = path.join(dir, 'subtitle.txt');
  const vmDir = voicemailFolder(storyId);

  const metaMs = fileMtimeMsSafe(meta);
  const txtMs  = Math.max(fileMtimeMsSafe(head), fileMtimeMsSafe(sub));
  const vmMs   = newestMtimeInDir(vmDir, n => AUDIO_EXTS.has(path.extname(n).toLowerCase()));

  const keyMs = Math.max(metaMs, txtMs, vmMs) || 0;
  return `${storyId}:${keyMs}`;
}

function readStoryPresentation(storyId){
  const dir = storyFolder(storyId);
  let title = storyId, subtitle = '', thumbAbs = null, thumbName = null;

  try{
    const meta = JSON.parse(fs.readFileSync(path.join(dir,'metadata.json'),'utf8'));
    if (meta.title)    title = String(meta.title);
    if (meta.subtitle) subtitle = String(meta.subtitle);
    if (meta.thumbnail){
      const p = path.join(dir, String(meta.thumbnail));
      if (fs.existsSync(p)) { thumbAbs = p; thumbName = path.basename(p); }
    }
  }catch{}

  if (!thumbAbs){
    try{
      const candidates = fs.readdirSync(dir).filter(n => IMAGE_RE.test(n));
      if (candidates.length){
        thumbAbs = path.join(dir, candidates[0]);
        thumbName = candidates[0];
      }
    }catch{}
  }

  return { title, subtitle, thumbAbs, thumbName };
}

async function deleteDiscordRef(ref) {
  try {
    if (!ref || !ref.id) return;

    if (ref.type === 'thread') {
      const thread = await client.channels.fetch(ref.id);
      if (thread && thread.delete) {
        await thread.delete('Rotating weekly story');
        console.log(`🗑️ Deleted thread ${ref.id}`);
      }
    } else if (ref.type === 'message') {
      const ch = await client.channels.fetch(BREAKING_CHANNEL_ID);
      const msg = await ch.messages.fetch(ref.id);
      await msg.delete();
      console.log(`🗑️ Deleted message ${ref.id}`);
    }
  } catch (e) {
    console.error('deleteDiscordRef failed:', e);
  }
}

async function ensureStoryThread(storyId){
  const cycleKey = getStoryCycleKey(storyId);
  const sync = readStorySync();
  const existing = sync[storyId];

  if (existing && existing.cycleKey === cycleKey) return;

  if (existing && existing.ref && existing.ref.id) {
    await deleteDiscordRef(existing.ref);
  }

  const { title, subtitle, thumbAbs, thumbName } = readStoryPresentation(storyId);
  const ip = getLocalIp();
  const voicemailUrl = PUBLIC_API_BASE
    ? `${PUBLIC_API_BASE}/voicemail/${encodeURIComponent(storyId)}`
    : `http://${ip}:${API_PORT}/voicemail/${storyId}`;

  const contentLines = [
    `**${title}**`,
    subtitle ? subtitle : '',
    '',
    `🎧 Voicemail: ${voicemailUrl}`,
  ].filter(Boolean);
  const content = contentLines.join('\n');

  const ch = await client.channels.fetch(BREAKING_CHANNEL_ID);
  let ref = { type: 'message', id: null };

  try {
    if (ch.type === ChannelType.GuildForum) {
      const created = await ch.threads.create({
        name: title.slice(0, 90),
        message: thumbAbs
          ? { content, files: [{ attachment: thumbAbs, name: thumbName }] }
          : { content },
      });
      ref = { type: 'thread', id: created.id };
    } else {
      const sent = await ch.send(
        thumbAbs
          ? { content, files: [{ attachment: thumbAbs, name: thumbName }] }
          : { content }
      );
      ref = { type: 'message', id: sent.id };
    }
  } catch (e) {
    console.error('ensureStoryThread post failed:', e);
    return;
  }

  sync[storyId] = { cycleKey, ref };
  writeStorySync(sync);
  console.log(`🧵 Rotated ${storyId} → ${ref.type} ${ref.id}`);
}

async function syncAllStories(){
  try{
    let dirs = [];
    try{
      dirs = fs.readdirSync(STORIES_ROOT, { withFileTypes:true })
        .filter(d => d.isDirectory() && /^Story\d+/i.test(d.name))
        .map(d => d.name);
    }catch{}
    const list = dirs.length ? dirs : ['Story1','Story2','Story3','Story4','Story5'];
    for (const id of list) {
      await ensureStoryThread(id);
    }
  }catch(e){
    console.error('syncAllStories error:', e);
  }
}

// ===================== API (single web server) =====================
function startApi(){
  ensureData();

  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));

  // Health
  app.get('/health', (_req, res) => res.json({ ok: true }));

  // Static mounts
  app.use('/spotlight-static', express.static(SPOTLIGHT_FEED_DIR, { fallthrough: true }));
  app.use('/static',           express.static(STORIES_ROOT,      { fallthrough: true }));

  // Public voicemail stream (inline, no filename leak)
  function streamVoicemail(res, filePath){
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Accept-Ranges', 'none');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    fs.createReadStream(filePath).pipe(res);
  }
  app.get('/voicemail/:story', (req, res) => {
    try{
      const story = String(req.params.story || '');
      const fp = firstVoicemailFile(story);
      if (!fp) return res.status(404).send('No voicemail for this story');
      streamVoicemail(res, fp);
    }catch(e){
      console.error('voicemail route error:', e);
      res.status(500).send('Server error');
    }
  });
  app.get('/stories/:id/voicemail', (req, res) => {
    try{
      const id = String(req.params.id || '');
      const fp = firstVoicemailFile(id);
      if (!fp) return res.status(404).send('No voicemail for this story');
      streamVoicemail(res, fp);
    }catch(e){
      console.error('voicemail stream error:', e);
      res.status(500).send('Server error');
    }
  });

  // Public: geo lookup
  app.get('/geo', async (req, res) => {
    try {
      const q = (req.query.q || '').toString().trim();
      if (!q) return res.status(400).json({ error: 'missing q' });

      const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&limit=5&countrycodes=us&q=${encodeURIComponent(q)}`;
      const r = await fetch(url, {
        headers: { 'User-Agent': 'soapbox-app/1.0 (contact: admin@bluecollarsoapbox.com)' }
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();

      const out = (Array.isArray(data) ? data : []).map(item => {
        const a = item.address || {};
        const city = a.city || a.town || a.village || a.hamlet || a.county || '';
        const state = a.state || a.region || '';
        return {
          label: item.display_name,
          city,
          state,
          lat: Number(item.lat),
          lon: Number(item.lon),
        };
      }).filter(x => x.state);

      res.json(out);
    } catch (e) {
      console.error('geo error:', e);
      res.status(500).json({ error: 'server error' });
    }
  });

  // --- Witness upload to S3 (replaces local) ---
  const uploadMem = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 200 * 1024 * 1024 }, // 200 MB
  });

  const sanitize = (s) =>
    String(s || '').replace(/[^\w\-\s.]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80);

  const pickExt = (original, mimetype) => {
    const ext = path.extname(original || '').toLowerCase();
    if (ext) return ext;
    if (/quicktime/i.test(mimetype)) return '.mov';
    if (/mp4/i.test(mimetype)) return '.mp4';
    return '.mp4';
  };

  async function handleWitnessS3(req, res) {
    try {
      // auth
      if (!authOk(req)) return res.status(401).json({ error: 'Unauthorized' });
      if (!S3_BUCKET)   return res.status(500).json({ error: 'S3 bucket not configured' });
      if (!req.file)    return res.status(400).json({ error: 'video file required (field "video")' });

      const { storyId = '', storyTitle = '', note = '' } = req.body || {};
      if (!storyId) return res.status(400).json({ error: 'storyId required' });

      const cleanId    = sanitize(storyId);
      const cleanTitle = sanitize(storyTitle) || cleanId;

      const ext   = pickExt(req.file.originalname, req.file.mimetype);
      const time  = new Date().toISOString().replace(/[:.]/g, '').replace('T','_').slice(0,15);
      const rand  = crypto.randomBytes(3).toString('hex');

      const key = `stories/${cleanId}/witnesses/${time}_${rand}_${cleanTitle}${ext}`;

      // 1) Put into S3
      await s3.send(new PutObjectCommand({
        Bucket: S3_BUCKET,
        Key: key,
        Body: req.file.buffer,
        ContentType: req.file.mimetype || 'application/octet-stream',
      }));

      // 2) Post the same buffer to Discord (inline playable)
      try {
        // Find the story thread id if it exists
        let threadId = null;
        try {
          const sync = readJSONSafe(STORY_SYNC, {});
          const ref = sync?.[cleanId]?.ref;
          if (ref && ref.type === 'thread' && ref.id) threadId = ref.id;
        } catch {}

        const target = await client.channels.fetch(threadId || BREAKING_CHANNEL_ID);
        const filename = path.basename(key); // nice name in Discord

        await target.send({
          content: `🧾 **Witness Video**\nStory: ${cleanTitle}${note ? `\nNote: ${String(note).slice(0,500)}` : ''}`,
          files: [{ attachment: req.file.buffer, name: filename }],
          allowedMentions: { parse: [] },
        });

        console.log(`📤 Witness posted for ${cleanId} → ${threadId ? 'thread' : '#breaking-news'}`);
      } catch (e) {
        console.error('Discord post failed (witness):', e);
      }

      // 3) Update local witness index (for the in-app feed UI, if you keep using it)
      try {
        const wid = newId();
        const publicUrl = `/static/${cleanId}/witnesses/${path.basename(key)}`; // NOTE: this URL is meaningful only if you also mirror to local disk; leave as placeholder.
        const list = loadWitnesses(cleanId);
        list.unshift({ id: wid, uri: publicUrl, ts: Date.now(), likes: 0, likedBy: [] });
        saveWitnesses(cleanId, list);
      } catch (e) {
        // Non-fatal
      }

      return res.json({ ok: true, bucket: S3_BUCKET, key, size: req.file.size, contentType: req.file.mimetype || null });
    } catch (e) {
      console.error('[witness->s3] upload error:', e);
      return res.status(500).json({ error: 'Upload failed' });
    }
  }

  app.post('/witness',       uploadMem.single('video'), handleWitnessS3);
  app.post('/api/witness',   uploadMem.single('video'), handleWitnessS3);
  app.get('/witness/ping', (req, res) => {
    if (!authOk(req)) return res.status(401).json({ error: 'Unauthorized' });
    res.json({ ok: true });
  });
  app.get('/api/witness/ping', (req, res) => {
    if (!authOk(req)) return res.status(401).json({ error: 'Unauthorized' });
    res.json({ ok: true });
  });

  // --- Public stories list (metadata-driven) ---
  app.get('/stories', (req, res) => {
    try {
      const dirs = fs.readdirSync(STORIES_ROOT, { withFileTypes: true })
        .filter(d => d.isDirectory() && /^Story\d+/i.test(d.name))
        .map(d => d.name);

      const list = dirs.length ? dirs : ['Story1','Story2','Story3','Story4','Story5'];

      const out = list.map(id => {
        const dir   = path.join(STORIES_ROOT, id);
        const voDir = path.join(dir, 'voicemail');
        const wiDir = path.join(dir, 'witnesses');
        if (!fs.existsSync(voDir)) fs.mkdirSync(voDir, { recursive: true });
        if (!fs.existsSync(wiDir)) fs.mkdirSync(wiDir, { recursive: true });

        let title = id, subtitle = '', thumbUrl = null;
        const metaPath = path.join(dir, 'metadata.json');
        try {
          const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
          title = (meta.title || id).toString();
          subtitle = (meta.subtitle || '').toString();

          const thumbName = (meta.thumbnail || '').toString();
          if (thumbName) {
            const imgFull = path.join(dir, thumbName);
            if (fs.existsSync(imgFull)) {
              const imgM = fs.statSync(imgFull).mtimeMs | 0;
              const metaM = fs.existsSync(metaPath) ? (fs.statSync(metaPath).mtimeMs | 0) : 0;
              const v = Math.max(imgM, metaM);
              thumbUrl = `/static/${id}/${thumbName}?v=${v}`;
            }
          }
        } catch {}

        // witness count (local)
        let witnessCount = 0;
        try { witnessCount = fs.readdirSync(wiDir).filter(f => VIDEO_RE.test(f)).length; } catch {}

        const updatedAt = new Date(Math.max(
          newestMTimeOf(dir),
          newestMTimeOf(voDir),
          newestMTimeOf(wiDir),
        )).toISOString();

        return { id, title, subtitle, thumbUrl, witnessCount, updatedAt };
      });

      out.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
      res.setHeader('Cache-Control', 'no-store');
      res.json(out);
    } catch (e) {
      console.error('/stories error:', e);
      res.setHeader('Cache-Control', 'no-store');
      res.json([]);
    }
  });

  // --- Witness list (local JSON index) ---
  app.get('/stories/:id/witnesses', (req, res) => {
    try {
      const storyId = String(req.params.id || '').trim();
      if (!storyId) return res.status(400).json({ error: 'Missing story id' });
      const list = loadWitnesses(storyId);
      res.json(Array.isArray(list) ? list : []);
    } catch {
      res.json([]);
    }
  });

  // Like / Unlike (local index)
  app.post('/witness/like', express.json(), (req, res) => {
    try {
      const storyId  = String(req.body?.storyId || '').trim();
      const witnessId = String(req.body?.witnessId || '').trim();
      const deviceId = String(req.body?.deviceId || '').trim();

      if (!storyId || !witnessId || !deviceId) {
        return res.status(400).json({ error: 'Missing storyId, witnessId, or deviceId' });
      }
      const list = loadWitnesses(storyId);
      const i = list.findIndex(x => x.id === witnessId);
      if (i < 0) return res.status(404).json({ error: 'Not found' });

      const likedBy = new Set(list[i].likedBy || []);
      if (likedBy.has(deviceId)) likedBy.delete(deviceId);
      else likedBy.add(deviceId);

      list[i].likedBy = Array.from(likedBy);
      list[i].likes = list[i].likedBy.length;
      saveWitnesses(storyId, list);

      res.json({ ok: true, likes: list[i].likes, liked: likedBy.has(deviceId) });
    } catch (e) {
      console.error('like err', e);
      res.status(500).json({ error: 'Failed' });
    }
  });

  // --- Spotlight feeds ---
  app.get('/spotlight-videos', (req, res) => {
    try {
      const base = SPOTLIGHT_FEED_DIR;
      if (!fs.existsSync(base)) return res.json([]);

      const entries = fs.readdirSync(base, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name);

      const items = [];
      for (const folder of entries) {
        const dir = path.join(base, folder);

        const title = readTextSafe(path.join(dir, 'title.txt')) || folder;
        const url   = readTextSafe(path.join(dir, 'link.txt'));

        let thumbName = null;
        try {
          const names = fs.readdirSync(dir).filter(n => IMAGE_RE.test(n));
          if (names.length) thumbName = names[0];
        } catch {}

        let thumbUrl = null;
        if (thumbName) {
          const thumbFull = path.join(dir, thumbName);
          const v = (fs.statSync(thumbFull).mtimeMs | 0);
          thumbUrl = `/spotlight-static/${encodeURIComponent(folder)}/${encodeURIComponent(thumbName)}?v=${v}`;
        }

        let dateIso = null;
        try { dateIso = (fs.statSync(dir).mtime || new Date()).toISOString(); }
        catch { dateIso = new Date().toISOString(); }

        if (url) items.push({ id: folder, title, url, thumb: thumbUrl, date: dateIso });
      }

      items.sort((a, b) => new Date(b.date) - new Date(a.date));
      res.json(items);
    } catch (e) {
      console.error('/spotlight-videos error:', e);
      res.status(500).json({ error: 'Server error' });
    }
  });

  app.get('/spotlight-feed', (req, res) => {
    try {
      const entries = fs.readdirSync(SPOTLIGHT_FEED_DIR, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name);

      const items = [];
      for (const id of entries) {
        const dir = path.join(SPOTLIGHT_FEED_DIR, id);

        let title = id;
        const t = readTextSafe(path.join(dir, 'title.txt'));
        if (t) title = t;

        const linkUrl = readTextSafe(path.join(dir, 'link.txt'));

        let thumbName = null;
        try {
          const files = fs.readdirSync(dir);
          const img = files.find(n => /\.(jpg|jpeg|png|webp)$/i.test(n));
          if (img) thumbName = img;
        } catch {}

        const updatedAt = new Date(newestMTimeOf(dir)).toISOString();
        const thumbUrl = thumbName
          ? `/spotlight-static/${encodeURIComponent(id)}/${encodeURIComponent(thumbName)}?v=${Date.now()}`
          : null;

        items.push({ id, title, linkUrl, thumbUrl, updatedAt });
      }

      items.sort((a,b) => new Date(b.updatedAt) - new Date(a.updatedAt));
      res.setHeader('Cache-Control', 'no-store');
      res.json(items);
    } catch (e) {
      console.error('/spotlight-feed error:', e);
      res.status(500).json({ error: 'server error' });
    }
  });

  // --- Confessions (public GET, open POST) ---
  app.get('/confessions', (req,res)=>{
    const items = readJSONSafe(CONF_JSON, [])
      .sort((a,b)=> b.ts - a.ts)
      .slice(0,100);
    res.json(items);
  });
  app.post('/confessions', async (req,res)=>{
    try{
      let { text, deviceId } = req.body || {};
      text = (text||'').toString().trim();
      deviceId = (deviceId||'').toString().slice(0,128);
      if (!text) return res.status(400).json({ error:'Empty confession' });
      if (text.length > 1000) return res.status(400).json({ error:'Too long (max 1000 chars)' });
      if (!deviceId) return res.status(400).json({ error:'Missing deviceId' });

      const items = readJSONSafe(CONF_JSON, []);
      const noLimit = process.env.SOAPBOX_DISABLE_RATE_LIMIT === '1';
      if (!noLimit){
        const windowStart = Date.now() - 24*60*60*1000;
        const recent = items.filter(x => x.deviceId === deviceId && x.ts >= windowStart);
        if (recent.length >= 5) return res.status(429).json({ error:'Rate limit: 5 per 24h' });
      }

      try {
        const ch = await client.channels.fetch(CONFESSIONS_CHANNEL_ID);
        await ch.send({ content:`**Anonymous Confession**\n${text}`, allowedMentions:{ parse:[] } });
      } catch (err) {
        console.error('Discord send failed (confession):', err);
      }

      const entry = { id: String(Date.now()), text, ts: Date.now(), deviceId };
      items.unshift(entry);
      fs.writeFileSync(CONF_JSON, JSON.stringify(items.slice(0,500), null, 2));
      res.json({ ok:true, item:entry });
    }catch(e){
      console.error('Confession POST error:', e);
      res.status(500).json({ error:'Server error' });
    }
  });

  // --- Admin: sync / rotate stories ---
  app.post('/admin/sync-stories', async (req,res)=>{
    if (!authOk(req)) return res.status(401).json({ error:'Unauthorized' });
    try { await syncAllStories(); res.json({ ok:true }); }
    catch(e){ console.error('admin sync error:', e); res.status(500).json({ ok:false, error:'sync failed' }); }
  });

  app.post('/admin/rotate-stories', async (req, res) => {
    if (!authOk(req)) return res.status(401).json({ error:'Unauthorized' });
    try {
      const sync = readStorySync();
      for (const [id, info] of Object.entries(sync)) {
        try { await deleteDiscordRef(info?.ref); } catch (e) { console.error(`delete ref failed for ${id}:`, e); }
      }
      writeStorySync({});
      await syncAllStories();
      res.json({ ok: true });
    } catch (e) {
      console.error('rotate-stories error:', e);
      res.status(500).json({ ok: false, error: 'rotate failed' });
    }
  });

  app.post('/admin/rotate-story/:id', async (req, res) => {
    if (!authOk(req)) return res.status(401).json({ error:'Unauthorized' });
    try {
      const id = String(req.params.id || '');
      const sync = readStorySync();
      if (sync[id]?.ref) { await deleteDiscordRef(sync[id].ref); }
      delete sync[id];
      writeStorySync(sync);
      await ensureStoryThread(id);
      res.json({ ok: true });
    } catch (e) {
      console.error('rotate-story error:', e);
      res.status(500).json({ ok: false, error: 'rotate failed' });
    }
  });

  app.listen(API_PORT, '0.0.0.0', () => {
    const ip = getLocalIp();
    console.log(`📡 API listening on http://${ip}:${API_PORT}`);
    console.log('   PUBLIC:  GET /health, GET /voicemail/:story, GET /stories/:id/voicemail, GET /static/... (thumbnails/videos), GET /spotlight-videos, GET /spotlight-feed, GET /confessions, GET /stories, GET /geo');
    console.log('   SECURE:  POST /confessions (allowed public in gate above), POST /witness, POST /admin/sync-stories, POST /admin/rotate-stories, POST /admin/rotate-story/:id  (x-soapbox-key required)');
  });
} // end startApi()

// ===================== Old voicemail drop watcher (optional) =====================
const processing = new Set();
function startWatcher(){
  ensureData();
  if (!WATCH_DIR) {
    console.warn('⚠️ WATCH_DIR not found (unset). Skipping drop-folder watcher.');
    return;
  }
  try { fs.mkdirSync(WATCH_DIR, { recursive: true }); } catch {}
  if (!fs.existsSync(WATCH_DIR)) {
    console.warn(`⚠️ WATCH_DIR not found (${WATCH_DIR}). Skipping drop-folder watcher.`);
    return;
  }
  console.log(`👀 Watching: ${WATCH_DIR}`);
  try {
    fs.watch(WATCH_DIR, { persistent: true }, async (_e, file) => {
      if (!file) return;
      const full = path.join(WATCH_DIR, file);
      try { await fsp.access(full); } catch { return; }
      if (!isAudio(full)) return;
      if (processing.has(full)) return;
      processing.add(full);
      try{
        if (SAFE_NAME_RE.test(path.basename(full))) { processing.delete(full); return; }
        console.log('📥 New audio:', full);
        await waitForSettle(full);
        const safe = await renameSafe(full);
        await postVoicemail(safe);
      }catch(e){
        console.error('watcher error:', e);
      }finally{
        processing.delete(full);
      }
    }).on('error', (err) => {
      console.error('Watcher failed:', err);
    });
  } catch (err) {
    console.error('Failed to start watcher:', err);
  }
}

// ===================== boot =====================
client.once('ready', ()=>{
  console.log(`✅ Logged in as ${client.user.tag}`);
  startWatcher();
  startApi();            // single web server lives here
  setTimeout(syncAllStories, 3000);
  setInterval(syncAllStories, 60 * 1000);
});

client.login(TOKEN).catch(err=>{
  console.error('❌ Discord login failed. Check DISCORD_TOKEN.', err);
  process.exit(1);
});

module.exports.getClient = () => client;
global.soapboxClient = client;
