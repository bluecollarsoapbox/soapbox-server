// ===================== Soapbox Discord Bot (stories + confessions + witness) =====================
require('dotenv').config();

// ---- fetch (Node 18+ has global.fetch; older Node needs node-fetch) ----
let _fetch = global.fetch;
if (!_fetch) {
  _fetch = (...args) => import('node-fetch').then(m => m.default(...args));
}
const fetch = (...args) => _fetch(...args);

const fs = require('fs');
const os = require('os');
const fsp = require('fs/promises');
const path = require('path');
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { Client, GatewayIntentBits, AttachmentBuilder, ChannelType } = require('discord.js');

// ---- Secrets (.env) ----
// (CHANGED) Normalize and log the token safely (first/last 4 chars + length)
let tokenRaw = process.env.DISCORD_TOKEN ?? '';
tokenRaw = typeof tokenRaw === 'string' ? tokenRaw.trim() : '';
console.log('[BOOT] DISCORD_TOKEN ->', tokenRaw ? `${tokenRaw.slice(0,4)}…${tokenRaw.slice(-4)} len=${tokenRaw.length}` : 'MISSING');
const TOKEN   = tokenRaw;                                                   // REQUIRED
const API_KEY = process.env.SOAPBOX_API_KEY || '99dnfneeekdegnrJJSN3JdenrsdnJ';

// ---- Discord channels ----
const VOICEMAIL_CHANNEL_ID   = '1407177470997696562';
const CONFESSIONS_CHANNEL_ID = '1407177292605685932';
const BREAKING_CHANNEL_ID    = '1407176815285637313';

// 🔒 Spotlight submissions go here (make a private channel and paste its ID)
const SPOTLIGHT_CHANNEL_ID = '1411392998427856907';

// ---- Folders (portable via .env; Windows defaults only on your PC) ----
const API_PORT = process.env.PORT ? Number(process.env.PORT) : 3030;

// Base paths (portable across Render Linux and your Windows dev box)
const LINUX_DATA = fs.existsSync('/data') ? '/data' : null;               // Render’s mounted disk if present
const WIN_ROOT   = 'D:\\Soapbox App';

// Base data folder used by all JSON/state
const DATA_DIR = process.env.DATA_DIR
  || (LINUX_DATA ? path.join(LINUX_DATA) : path.join(WIN_ROOT, 'data'));

// Spotlight feed (folders you create for each video)
const SPOTLIGHT_FEED_DIR = process.env.SPOTLIGHT_FEED_DIR
  || (LINUX_DATA ? path.join(LINUX_DATA, 'Spotlights') : path.join(WIN_ROOT, 'Spotlights'));

// Stories root (Story1/Story2/... with metadata/voicemail/witnesses)
const STORIES_ROOT = process.env.STORIES_ROOT
  || (LINUX_DATA ? path.join(LINUX_DATA, 'Stories') : path.join(WIN_ROOT, 'Stories'));


// Old voicemail drop folder the watcher still supports (empty by default on servers)
const WATCH_DIR = process.env.WATCH_DIR || '';  // <<< IMPORTANT: no Windows fallback here

// JSON files the server writes/reads
const CONF_JSON      = path.join(DATA_DIR, 'confessions.json');
const SPOTLIGHT_JSON = path.join(DATA_DIR, 'spotlight.json');      // used by /spotlight POSTs
const STORY_SYNC     = path.join(DATA_DIR, 'stories-sync.json');   // story rotation memory
const SPOTLIGHT_FEED_JSON = path.join(DATA_DIR, 'spotlight-feed.json'); // (kept, unused by default)

// ---- File rules ----
const AUDIO_EXTS   = new Set(['.mp3', '.m4a', '.ogg', '.wav']);
const VIDEO_RE     = /\.(mp4|mov|mkv|webm|avi)$/i;
const IMAGE_RE     = /\.(jpg|jpeg|png|webp)$/i;
const SAFE_NAME_RE = /^Voicemail_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}(?:_\d+)?\.(mp3|m4a|ogg|wav)$/i;
const SETTLE_MS = 800;
const SETTLE_ROUNDS = 3;

// ---- Discord client ----
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });

console.log('[PATHS]',
  'DATA_DIR=', DATA_DIR,
  'STORIES_ROOT=', STORIES_ROOT,
  'SPOTLIGHT_FEED_DIR=', SPOTLIGHT_FEED_DIR
);


// ===================== helpers =====================
const pad = (n) => String(n).padStart(2, '0');
const isAudio = (p) => AUDIO_EXTS.has(path.extname(p).toLowerCase());

function tsBase(d = new Date()){
  return `Voicemail_${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}
function stamp(){
  const d = new Date();
  return `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}_${d.getHours().toString().padStart(2,'0')}${d.getMinutes().toString().padStart(2,'0')}${d.getSeconds().toString().padStart(2,'0')}`;
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

async function postVoicemail(filePath){
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

  // NEW: if you configured WATCH_DIR, make sure it exists so we can actually watch it
  if (WATCH_DIR) {
    try { fs.mkdirSync(WATCH_DIR, { recursive: true }); } 
    catch (e) { console.warn('Could not create WATCH_DIR:', WATCH_DIR, e?.message || e); }
  }
}

function readJSONSafe(fp, fallback){
  try { return JSON.parse(fs.readFileSync(fp, 'utf-8')); }
  catch { return fallback; }
}
function readTextSafe(fp){
  try { return fs.readFileSync(fp, 'utf8').trim(); } catch { return ''; }
}

function getLocalIp(){
  const ifs = os.networkInterfaces();
  for (const name of Object.keys(ifs)) for (const net of (ifs[name] || [])) {
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
// --- witness index helpers (store alongside each StoryN folder) ---
function readJsonSafe(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}
function writeJsonSafe(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
}
function storyDir(storyId) {
  return path.join(STORIES_ROOT, storyId); // STORIES_ROOT already defined in your file
}
function witnessIndexPath(storyId) {
  return path.join(storyDir(storyId), 'witnesses.json');
}
function loadWitnesses(storyId) {
  return readJsonSafe(witnessIndexPath(storyId), []); // [{id, uri, ts, likes, likedBy:[]}]
}
function saveWitnesses(storyId, list) {
  writeJsonSafe(witnessIndexPath(storyId), list);
}
function newId() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}


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

  // Prefer metadata.json
  try{
    const meta = JSON.parse(fs.readFileSync(path.join(dir,'metadata.json'),'utf8'));
    if (meta.title)    title = String(meta.title);
    if (meta.subtitle) subtitle = String(meta.subtitle);
    if (meta.thumbnail){
      const p = path.join(dir, String(meta.thumbnail));
      if (fs.existsSync(p)) { thumbAbs = p; thumbName = path.basename(p); }
    }
  }catch{}

  // If still no thumb and there’s any image in the folder, grab the first
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

// Delete the previous Discord post (thread or message) for a story
async function deleteDiscordRef(ref) {
  try {
    if (!ref || !ref.id) return;

    if (ref.type === 'thread') {
      // Threads are channels in discord.js v14
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

  // If nothing changed this cycle, do nothing
  if (existing && existing.cycleKey === cycleKey) return;

  // If an old post exists, delete it first (rotate)
  if (existing && existing.ref && existing.ref.id) {
    await deleteDiscordRef(existing.ref);
  }

  // Build the current content
  const { title, subtitle, thumbAbs, thumbName } = readStoryPresentation(storyId);
  const ip = getLocalIp();
  const voicemailUrl = `http://${ip}:${API_PORT}/voicemail/${storyId}`;

  const contentLines = [
    `**${title}**`,
    subtitle ? subtitle : '',
    '',
    `🎧 Voicemail: ${voicemailUrl}`,
  ].filter(Boolean);
  const content = contentLines.join('\n');

  // Post a fresh thread/message
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
    return; // don’t write sync if posting failed
  }

  // Save new reference for this cycle
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

// ===================== API =====================
function startApi(){
  ensureData();

  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '64kb' }));

  // --- PUBLIC health check (added) ---
  app.get('/health', (_req, res) => res.json({ ok: true })); // <<< added

  // Static for Spotlight thumbnails (single mount, correct path)
  app.use('/spotlight-static', express.static(SPOTLIGHT_FEED_DIR, { fallthrough: true }));

  // Static serving so the app can load thumbnails/witness videos
  app.use('/static', express.static(STORIES_ROOT, { fallthrough: true }));

  // ---- PUBLIC voicemail stream (no API key) ----
  function streamVoicemail(res, filePath){
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Disposition', 'inline');   // no filename leak
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Accept-Ranges', 'none');           // disable byte-range
    res.setHeader('X-Content-Type-Options', 'nosniff');
    fs.createReadStream(filePath).pipe(res);
  }

  app.get('/voicemail/:story', (req, res) => {
    try{
      const story = (req.params.story||'').toString();
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
      const id = (req.params.id||'').toString();
      const fp = firstVoicemailFile(id);
      if (!fp) return res.status(404).send('No voicemail for this story');
      streamVoicemail(res, fp);
    }catch(e){
      console.error('voicemail stream error:', e);
      res.status(500).send('Server error');
    }
  });

  // ---- PUBLIC: city/state autocomplete (no API key required) ----
  app.get('/geo', async (req, res) => {
    try {
      const q = (req.query.q || '').toString().trim();
      if (!q) return res.status(400).json({ error: 'missing q' });

      // OpenStreetMap Nominatim (USA only, top 5)
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

  // ---- AUTH GATE with allowlist (replaces blanket 401) ----
  const PUBLIC_PREFIXES = ['/static', '/spotlight-static'];
  const PUBLIC_ROUTES = new Set([
    '/health',
    '/voicemail',
    '/spotlight-videos',
    '/spotlight-feed',
    '/confessions',   // GET public
    '/stories',       // GET public
    '/geo'
  ]);

  app.use((req, res, next) => {
    if (req.method === 'OPTIONS') return next();

    // allow static mounts
    if (PUBLIC_PREFIXES.some(p => req.path.startsWith(p))) return next();

    // allow listed GET endpoints
    for (const base of PUBLIC_ROUTES) {
      if (req.path === base || req.path.startsWith(base + '/')) {
        if (req.method === 'GET') return next();
        break;
      }
    }

    // explicitly allow POST /confessions (rate-limited in handler)
    if (req.method === 'POST' && (req.path === '/confessions' || req.path.startsWith('/confessions/'))) {
      return next();
    }

    // everything else requires key
    if (!authOk(req)) return res.status(401).json({ error: 'Unauthorized' });
    next();
  });
  // ---- end allowlist gate ----

  // --- Spotlight feed (scan D:\Soapbox App\Spotlights\* subfolders)
  app.get('/spotlight-videos', (req, res) => {
    try {
      const base = SPOTLIGHT_FEED_DIR;
      if (!fs.existsSync(base)) {
        return res.json([]); // nothing yet
      }

      // list subfolders only
      const entries = fs.readdirSync(base, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name);

      const items = [];
      for (const folder of entries) {
        const dir = path.join(base, folder);

        // read files if present
        const title = readTextSafe(path.join(dir, 'title.txt')) || folder;
        const url   = readTextSafe(path.join(dir, 'link.txt'));

        // find a thumbnail (jpg/png/webp)
        let thumbName = null;
        try {
          const names = fs.readdirSync(dir).filter(n => IMAGE_RE.test(n));
          if (names.length) thumbName = names[0];
        } catch {}

        // build thumb URL if we found one
        let thumbUrl = null;
        if (thumbName) {
          const thumbFull = path.join(dir, thumbName);
          const v = (fs.statSync(thumbFull).mtimeMs | 0);
          thumbUrl = `/spotlight-static/${encodeURIComponent(folder)}/${encodeURIComponent(thumbName)}?v=${v}`;
        }

        // folder timestamp for sorting (fallback to dir mtime)
        let dateIso = null;
        try {
          const s = fs.statSync(dir);
          dateIso = (s.mtime || s.ctime || new Date()).toISOString();
        } catch {
          dateIso = new Date().toISOString();
        }

        // only include if there is at least a link
        if (url) {
          items.push({
            id: folder,
            title,
            url,
            thumb: thumbUrl,
            date: dateIso,
          });
        }
      }

      // newest first
      items.sort((a, b) => new Date(b.date) - new Date(a.date));
      res.json(items);
    } catch (e) {
      console.error('/spotlight-videos error:', e);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // (Legacy/optional) Spotlight feed that returns similar list; kept but corrected URL path
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

  // --- Admin: force-resync stories to Discord forum/text ---
  app.post('/admin/sync-stories', (req,res)=>{
    syncAllStories()
      .then(()=> res.json({ ok:true }))
      .catch(e=>{
        console.error('admin sync error:', e);
        res.status(500).json({ ok:false, error:'sync failed' });
      });
  });

  // --- Admin: force rotate (delete old posts, recreate fresh) ---
  app.post('/admin/rotate-stories', async (req, res) => {
    try {
      const sync = readStorySync();

      // 1) delete all existing refs
      for (const [id, info] of Object.entries(sync)) {
        try {
          await deleteDiscordRef(info?.ref);
        } catch (e) {
          console.error(`delete ref failed for ${id}:`, e);
        }
      }

      // 2) clear sync memory so next sync posts fresh
      writeStorySync({});

      // 3) rebuild all stories now
      await syncAllStories();

      res.json({ ok: true });
    } catch (e) {
      console.error('rotate-stories error:', e);
      res.status(500).json({ ok: false, error: 'rotate failed' });
    }
  });

  // --- Admin: rotate one story by ID ---
  app.post('/admin/rotate-story/:id', async (req, res) => {
    try {
      const id = String(req.params.id || '');
      const sync = readStorySync();

      if (sync[id]?.ref) {
        await deleteDiscordRef(sync[id].ref);
      }
      // remove its memory
      delete sync[id];
      writeStorySync(sync);

      // re-create just this story
      await ensureStoryThread(id);

      res.json({ ok: true });
    } catch (e) {
      console.error('rotate-story error:', e);
      res.status(500).json({ ok: false, error: 'rotate failed' });
    }
  });

  // --- Confessions feed + submit ---
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

      // Relay to Discord
      try {
        const ch = await client.channels.fetch(CONFESSIONS_CHANNEL_ID);
        await ch.send({ content:`**Anonymous Confession**\n${text}`, allowedMentions:{ parse:[] } });
      } catch (err) {
        console.error('Discord send failed (confession):', err);
        // (We still save locally and return ok; change if you prefer strict failure)
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

  // --- Spotlight submit (private; requires x-soapbox-key) ---
  // POST /spotlight  body: { name, email?, phone?, city, state, subject?, details, companies?:string[], consent:boolean }
  app.post('/spotlight', async (req, res) => {
    try {
      const {
        name = '',
        email = '',
        phone = '',
        city = '',
        state = '',
        subject = '',
        details = '',
        companies = [],
        consent = false,
      } = req.body || {};

      // Basic validation
      const clean = (s) => String(s || '').trim();
      const _name = clean(name);
      const _email = clean(email);
      const _phone = clean(phone);
      const _city = clean(city);
      const _state = clean(state);
      const _subject = clean(subject);
      const _details = clean(details);
      const _companies = Array.isArray(companies) ? companies.map(clean).filter(Boolean) : [];

      if (!_name) return res.status(400).json({ error: 'Name is required' });
      if (!_city || !_state) return res.status(400).json({ error: 'City and state are required' });
      if (!_email && !_phone) return res.status(400).json({ error: 'At least one contact (email or phone) is required' });
      if (_details.length < 20) return res.status(400).json({ error: 'Please provide more detail (min 20 chars)' });
      if (!consent) return res.status(400).json({ error: 'You must confirm consent' });

      // Save to JSON
      const items = readJSONSafe(SPOTLIGHT_JSON, []);
      const entry = {
        id: String(Date.now()),
        ts: Date.now(),
        name: _name,
        email: _email,
        phone: _phone,
        city: _city,
        state: _state,
        subject: _subject,
        details: _details,
        companies: _companies,
      };
      items.unshift(entry);
      fs.writeFileSync(SPOTLIGHT_JSON, JSON.stringify(items.slice(0, 1000), null, 2));

      // (Optional) relay to private Discord channel
      if (SPOTLIGHT_CHANNEL_ID && /^\d+$/.test(SPOTLIGHT_CHANNEL_ID)) {
        try {
          const ch = await client.channels.fetch(SPOTLIGHT_CHANNEL_ID);
          const lines = [
            `**New Spotlight Submission**`,
            _subject ? `**Subject:** ${_subject}` : null,
            `**Name:** ${_name}`,
            _email ? `**Email:** ${_email}` : null,
            _phone ? `**Phone:** ${_phone}` : null,
            `**Location:** ${_city}, ${_state}`,
            _companies.length ? `**Companies:** ${_companies.join(', ')}` : null,
            '',
            `**Details:**`,
            _details.slice(0, 1900), // avoid hitting Discord limit
          ].filter(Boolean).join('\n');

          await ch.send({ content: lines, allowedMentions: { parse: [] } });
        } catch (e) {
          console.error('Discord send failed (spotlight):', e);
        }
      }

      return res.json({ ok: true, item: entry });
    } catch (e) {
      console.error('Spotlight POST error:', e);
      return res.status(500).json({ error: 'Server error' });
    }
  });

  // (Optional) List spotlight (for your own admin UI/testing)
  app.get('/spotlight', (req, res) => {
    try {
      const items = readJSONSafe(SPOTLIGHT_JSON, []).sort((a,b)=> b.ts - a.ts).slice(0, 200);
      res.json(items);
    } catch (e) {
      res.json([]);
    }
  });
async function safeMove(src, dest) {
  try {
    fs.renameSync(src, dest);
  } catch (err) {
    if (err && err.code === 'EXDEV') {
      // Cross-device: copy then unlink
      await new Promise((resolve, reject) => {
        const rd = fs.createReadStream(src);
        const wr = fs.createWriteStream(dest);
        rd.on('error', reject);
        wr.on('error', reject);
        wr.on('close', resolve);
        rd.pipe(wr);
      });
      try { fs.unlinkSync(src); } catch {}
    } else {
      throw err;
    }
  }
}

  // --- Stories list (metadata.json only) ---
  // Returns: [{ id, title, subtitle, thumbUrl, witnessCount, updatedAt }]
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
              thumbUrl = `/static/${id}/${thumbName}?v=${v}`; // cache-bust when you replace file/meta
            }
          }
        } catch {}

        // witness count (video files)
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

  // --- Witness list (optional UI feed) ---
  // GET /stories/:id/witness -> [{ name, uri, createdAt }]
  app.get('/stories/:id/witness', (req,res)=>{
    const id = (req.params.id||'').toString();
    const wdir = witnessFolder(id);
    ensureDir(wdir);
    try{
      const items = fs.readdirSync(wdir)
        .filter(f => VIDEO_RE.test(f))
        .map(name => {
          const full = path.join(wdir, name);
          const stat = fs.statSync(full);
          return {
            name,
            uri: `/static/${id}/witnesses/${name}`,
            createdAt: (stat.mtime || stat.ctime || new Date()).toISOString(),
          };
        })
        .sort((a,b)=> new Date(b.createdAt) - new Date(a.createdAt));
      res.json(items);
    }catch(e){
      console.error('witness list error:', e);
      res.json([]);
    }
  });

// --- Witness upload -> save in StoryN\witnesses and post to Discord thread/channel (async) ---
const uploadTmp = path.join(DATA_DIR, 'tmp');
ensureDir(uploadTmp);
const upload = multer({ dest: uploadTmp });

app.post('/witness', upload.any(), async (req, res) => {
  req.setTimeout(0);
  try {
    const storyId = (req.body?.storyId || '').toString().trim();
    const note    = (req.body?.note || '').toString().trim();
    if (!storyId) return res.status(400).json({ error: 'Missing storyId' });

    const file = (req.files || []).find(f => f.fieldname === 'video' || f.fieldname === 'file');
    if (!file) return res.status(400).json({ error: 'No file' });

    const destDir = witnessFolder(storyId);
    ensureDir(destDir);

    const ext = (path.extname(file.originalname || '') || '.mp4').toLowerCase();
    const safeName = `${stamp()}_witness${ext}`;
    const destPath = path.join(destDir, safeName);

    // cross-device safe move
    try {
      fs.renameSync(file.path, destPath);
    } catch (e) {
      if (e && e.code === 'EXDEV') {
        fs.copyFileSync(file.path, destPath);
        fs.unlinkSync(file.path);
      } else {
        throw e;
      }
    }

    // public URL returned to the app immediately
    const publicUrl = `/static/${storyId}/witnesses/${path.basename(destPath)}`;

    // add this witness to the story index (for the in-app feed)
    const wid = newId();
    const entry = { id: wid, uri: publicUrl, ts: Date.now(), likes: 0, likedBy: [] };
    const list = loadWitnesses(storyId);
    list.unshift(entry);
    saveWitnesses(storyId, list);

    res.json({ ok: true, uri: publicUrl, id: wid });

    // post to Discord (thread if available, else channel)
    process.nextTick(async () => {
      try {
        const syncPath = path.join(DATA_DIR, 'stories-sync.json');
        let threadId = null;
        try {
          const sync = JSON.parse(fs.readFileSync(syncPath, 'utf8'));
          const ref = sync?.[storyId]?.ref;
          if (ref && ref.type === 'thread' && ref.id) threadId = ref.id;
        } catch {}

        const target = await client.channels.fetch(threadId || BREAKING_CHANNEL_ID);
        const payload = {
          content: `🧾 **Witness Video**\nStory: ${storyId}${note ? `\nNote: ${note}` : ''}`,
          files: [{ attachment: destPath, name: path.basename(destPath) }],
          allowedMentions: { parse: [] }
        };
        await target.send(payload);
        console.log(`📤 Witness posted for ${storyId} → ${threadId ? 'thread' : '#breaking-news'}`);
      } catch (e) {
        console.error('Discord post failed (witness):', e);
      }
    });

  } catch (e) {
    console.error('witness upload failed:', e);
    return res.status(500).json({ error: 'Upload failed' });
  }
});

// Get witnesses for a story (public)
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

// Like / Unlike a witness (needs deviceId; idempotent toggle)
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
    if (likedBy.has(deviceId)) {
      likedBy.delete(deviceId);
    } else {
      likedBy.add(deviceId);
    }
    list[i].likedBy = Array.from(likedBy);
    list[i].likes = list[i].likedBy.length;
    saveWitnesses(storyId, list);

    res.json({ ok: true, likes: list[i].likes, liked: likedBy.has(deviceId) });
  } catch (e) {
    console.error('like err', e);
    res.status(500).json({ error: 'Failed' });
  }
});



  // ---- listen ----
  app.listen(API_PORT, '0.0.0.0', () => { // <<< bound to all interfaces
    const ip = getLocalIp();
    console.log(`📡 API listening on http://${ip}:${API_PORT}`);
    console.log('   PUBLIC:  GET /health, GET /voicemail/:story, GET /stories/:id/voicemail, GET /static/... (thumbnails/videos), GET /spotlight-videos, GET /spotlight-feed, GET /confessions, GET /stories, GET /geo');
    console.log('   SECURE:  POST /confessions (allowed public in gate above), POST /witness, POST /admin/sync-stories, POST /admin/rotate-stories, POST /admin/rotate-story/:id  (x-soapbox-key required)');
  });
} // end startApi()

// ===================== Old voicemail drop watcher =====================
const processing = new Set();
function startWatcher(){
  ensureData();

  // If unset, skip entirely (good for Render when you don’t want the watcher)
  if (!WATCH_DIR) {
    console.warn('⚠️ WATCH_DIR not found (unset). Skipping drop-folder watcher.');
    return;
  }

  // Ensure the folder exists if configured (prevents ENOENT)
  try { fs.mkdirSync(WATCH_DIR, { recursive: true }); } catch {}

  if (!fs.existsSync(WATCH_DIR)) {
    console.warn(`⚠️ WATCH_DIR not found (${WATCH_DIR}). Skipping drop-folder watcher.`);
    return;
  }

  console.log(`👀 Watching: ${WATCH_DIR}`);

  // Wrap fs.watch so errors don’t crash the process
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
  startApi();

  // Kick once on startup, then every 60s
  setTimeout(syncAllStories, 3000);
  setInterval(syncAllStories, 60 * 1000);
});


client.login(TOKEN).catch(err=>{
  console.error('❌ Discord login failed. Check DISCORD_TOKEN.', err);
  process.exit(1);
});
