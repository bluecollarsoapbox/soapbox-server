// ===================== Soapbox Discord Bot (S3-backed stories) =====================
require('dotenv').config();

const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const express = require('express');
const cors = require('cors');
const { Client, GatewayIntentBits, ChannelType, AttachmentBuilder } = require('discord.js');
const { S3Client, ListObjectsV2Command, GetObjectCommand } = require('@aws-sdk/client-s3');

// ---------------------- ENV / CONFIG ----------------------
function readSecretFile(p) { try { return fs.readFileSync(p, 'utf8').trim(); } catch { return ''; } }

const TOKEN =
  (process.env.DISCORD_TOKEN || '').trim() ||
  readSecretFile('/etc/secrets/DISCORD_TOKEN') ||
  readSecretFile('/etc/secrets/discord_token');

if (!TOKEN) {
  console.error('❌ DISCORD_TOKEN missing.');
  process.exit(1);
}

const API_KEY = (process.env.SOAPBOX_API_KEY || '').trim();
const PORT    = Number(process.env.PORT || 3030);

// Discord channels (update if needed)
const BREAKING_CHANNEL_ID    = process.env.BREAKING_CHANNEL_ID    || '1407176815285637313';
const CONFESSIONS_CHANNEL_ID = process.env.CONFESSIONS_CHANNEL_ID || '1407177292605685932';
const VOICEMAIL_CHANNEL_ID   = process.env.VOICEMAIL_CHANNEL_ID   || '1407177470997696562';
const SPOTLIGHT_CHANNEL_ID   = process.env.SPOTLIGHT_CHANNEL_ID   || '1411392998427856907';

// S3
const S3_BUCKET = process.env.S3_BUCKET;           // e.g. soapbox-app-data
const S3_REGION = process.env.AWS_REGION || 'us-east-2';
if (!S3_BUCKET) {
  console.error('❌ S3_BUCKET not set.');
  process.exit(1);
}
const s3 = new S3Client({ region: S3_REGION });    // creds from env: AWS_ACCESS_KEY_ID/SECRET

// Persistent state (thread refs, etc.)
const RENDER_DATA = '/opt/render/project/data';
const DATA_DIR    = process.env.DATA_DIR || RENDER_DATA || path.join(os.tmpdir(), 'soapbox');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const STORY_SYNC  = path.join(DATA_DIR, 'stories-sync.json');

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });

console.log('[BOOT]',
  'DATA_DIR=', DATA_DIR,
  'S3_BUCKET=', S3_BUCKET,
  'S3_REGION=', S3_REGION
);

// ---------------------- S3 HELPERS ----------------------
async function s3List(prefix, maxKeys = 1000) {
  const out = [];
  let Token;
  do {
    const resp = await s3.send(new ListObjectsV2Command({
      Bucket: S3_BUCKET,
      Prefix: prefix,
      ContinuationToken: Token,
      MaxKeys: maxKeys
    }));
    (resp.Contents || []).forEach(o => out.push(o));
    Token = resp.IsTruncated ? resp.NextContinuationToken : undefined;
  } while (Token);
  return out;
}

async function s3GetJSON(key) {
  try {
    const r = await s3.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: key }));
    const buf = await streamToBuffer(r.Body);
    return JSON.parse(buf.toString('utf8'));
  } catch {
    return null;
  }
}

async function s3DownloadToTemp(key, preferredName) {
  const r = await s3.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: key }));
  const base = preferredName || path.basename(key);
  const tmp  = path.join(DATA_DIR, `tmp_${Date.now()}_${base}`);
  await pipelineToFile(r.Body, tmp);
  return tmp;
}

function streamToBuffer(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', c => chunks.push(c));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

function pipelineToFile(stream, filePath) {
  return new Promise((resolve, reject) => {
    const ws = fs.createWriteStream(filePath);
    stream.pipe(ws);
    ws.on('finish', resolve);
    ws.on('error', reject);
  });
}

const IMG_RE  = /\.(jpg|jpeg|png|webp)$/i;
const AUD_RE  = /\.(mp3|m4a|ogg|wav)$/i;

// ---------------------- STORY PRESENTATION FROM S3 ----------------------
/**
 * Story layout in S3:
 * stories/Story1/
 *   metadata.json (optional; { title, subtitle, thumbnail })
 *   <images> (.jpg/.png)
 *   voicemail/  (audio files)
 *   witnesses/  (video files; handled elsewhere)
 */
async function readStoryPresentationS3(storyId) {
  const base = `stories/${storyId}/`;

  // metadata.json
  const meta = await s3GetJSON(`${base}metadata.json`);
  let title = meta?.title || storyId;
  let subtitle = meta?.subtitle || '';

  // thumbnail: metadata.thumbnail (relative) or first image in folder
  let thumbKey = null;
  if (meta?.thumbnail) {
    const candidate = `${base}${String(meta.thumbnail)}`;
    thumbKey = candidate;
  } else {
    const objs = await s3List(base);
    const firstImg = objs.find(o => IMG_RE.test(o.Key));
    if (firstImg) thumbKey = firstImg.Key;
  }

  // latest voicemail audio
  const vmPrefix = `${base}voicemail/`;
  const vmObjs = (await s3List(vmPrefix)).filter(o => AUD_RE.test(o.Key));
  vmObjs.sort((a,b) => (b.LastModified?.getTime()||0) - (a.LastModified?.getTime()||0));
  const latestVm = vmObjs[0] || null;

  return {
    title,
    subtitle,
    thumbKey,              // may be null
    latestVoicemailKey: latestVm?.Key || null,
    modifiedAtMs: Math.max(
      meta ? Date.now() : 0,                           // reading meta body; no HEAD here
      thumbKey ? (findObjTime(await s3List(thumbKey))): 0,
      latestVm?.LastModified ? latestVm.LastModified.getTime() : 0
    )
  };
}

// helper: find LastModified for a single key (cheap list on exact key)
function findObjTime(list) {
  // list may be a single-item listObjects call on exact key, or empty
  const it = Array.isArray(list) ? list[0] : null;
  return it?.LastModified ? it.LastModified.getTime() : 0;
}

// cycleKey = string identifying the latest state we care about
async function getStoryCycleKeyS3(storyId) {
  const base = `stories/${storyId}/`;
  // check these keys/folders:
  // - metadata.json (mtime unknown unless we List on key)
  // - images in base (we’ll pick max mtime across images)
  // - latest voicemail in voicemail/
  const all = await s3List(base);
  let imgMs = 0, metaMs = 0;
  for (const o of all) {
    if (o.Key === `${base}metadata.json`) {
      metaMs = Math.max(metaMs, o.LastModified?.getTime() || 0);
    }
    if (IMG_RE.test(o.Key)) {
      imgMs = Math.max(imgMs, o.LastModified?.getTime() || 0);
    }
  }
  const vm = await s3List(`${base}voicemail/`);
  let vmMs = 0;
  for (const o of vm) if (AUD_RE.test(o.Key)) vmMs = Math.max(vmMs, o.LastModified?.getTime() || 0);

  const newest = Math.max(metaMs, imgMs, vmMs) || 0;
  return `${storyId}:${newest}`;
}

// ---------------------- STATE ----------------------
function readStorySync() {
  try { return JSON.parse(fs.readFileSync(STORY_SYNC, 'utf8')); } catch { return {}; }
}
function writeStorySync(obj) {
  fs.writeFileSync(STORY_SYNC, JSON.stringify(obj, null, 2));
}

// ---------------------- DISCORD POSTING ----------------------
async function deleteDiscordRef(ref) {
  if (!ref?.id) return;
  try {
    if (ref.type === 'thread') {
      const thread = await client.channels.fetch(ref.id);
      if (thread && thread.delete) await thread.delete('Rotating story');
    } else if (ref.type === 'message') {
      const ch = await client.channels.fetch(BREAKING_CHANNEL_ID);
      const msg = await ch.messages.fetch(ref.id);
      await msg.delete();
    }
    console.log('🗑️ Deleted previous ref', ref);
  } catch (e) {
    console.error('deleteDiscordRef failed:', e.message || e);
  }
}

async function ensureStoryThreadS3(storyId) {
  const cycleKey = await getStoryCycleKeyS3(storyId);
  const sync = readStorySync();
  const existing = sync[storyId];

  // no change? bail
  if (existing && existing.cycleKey === cycleKey) return;

  // remove old
  if (existing?.ref) await deleteDiscordRef(existing.ref);

  // build content
  const pres = await readStoryPresentationS3(storyId);
  const contentLines = [
    `**${pres.title}**`,
    pres.subtitle ? pres.subtitle : '',
  ].filter(Boolean);
  const content = contentLines.join('\n');

  // attach thumbnail if any (download, attach, then unlink)
  let files = undefined;
  let tmpThumb = null;
  if (pres.thumbKey) {
    try {
      tmpThumb = await s3DownloadToTemp(pres.thumbKey, path.basename(pres.thumbKey));
      files = [{ attachment: tmpThumb, name: path.basename(tmpThumb) }];
    } catch (e) {
      console.warn('thumb download failed:', pres.thumbKey, e.message || e);
    }
  }

  // post in forum (thread) or fallback to message
  const ch = await client.channels.fetch(BREAKING_CHANNEL_ID);
  let ref = { type: 'message', id: null };
  try {
    if (ch.type === ChannelType.GuildForum) {
      const created = await ch.threads.create({
        name: pres.title.slice(0, 90),
        message: files ? { content, files } : { content },
      });
      ref = { type: 'thread', id: created.id };
    } else {
      const sent = await ch.send(files ? { content, files } : { content });
      ref = { type: 'message', id: sent.id };
    }
  } catch (e) {
    console.error('ensureStoryThreadS3 post failed:', e.message || e);
    if (tmpThumb) try { fs.unlinkSync(tmpThumb); } catch {}
    return;
  }
  if (tmpThumb) try { fs.unlinkSync(tmpThumb); } catch {}

  // save new
  sync[storyId] = { cycleKey, ref };
  writeStorySync(sync);

  console.log(`🧵 Rotated ${storyId} → ${ref.type} ${ref.id}`);
}

async function syncAllStoriesS3() {
  // Find Story folders in S3 under stories/
  const roots = await s3List('stories/');
  const storyIds = Array.from(
    new Set(
      roots
        .map(o => o.Key)
        .map(k => {
          const m = k.match(/^stories\/(Story\d+)\//i);
          return m ? m[1] : null;
        })
        .filter(Boolean)
    )
  );
  const list = storyIds.length ? storyIds : ['Story1','Story2','Story3','Story4','Story5'];
  for (const id of list) await ensureStoryThreadS3(id);
}

// ---------------------- ADMIN API ----------------------
function authOk(req) {
  const sent = (req.headers['x-soapbox-key'] || req.query.key || '').toString().trim();
  return API_KEY && sent === API_KEY;
}

function startApi() {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '64kb' }));

  app.get('/health', (_req, res) => res.json({ ok: true }));

  app.post('/admin/sync-stories', async (req, res) => {
    if (!authOk(req)) return res.status(401).json({ error: 'Unauthorized' });
    try {
      await syncAllStoriesS3();
      res.json({ ok: true });
    } catch (e) {
      console.error('sync-stories failed:', e);
      res.status(500).json({ ok: false });
    }
  });

  app.post('/admin/rotate-stories', async (req, res) => {
    if (!authOk(req)) return res.status(401).json({ error: 'Unauthorized' });
    try {
      const sync = readStorySync();
      for (const k of Object.keys(sync)) {
        try { await deleteDiscordRef(sync[k].ref); } catch {}
      }
      writeStorySync({});
      await syncAllStoriesS3();
      res.json({ ok: true });
    } catch (e) {
      console.error('rotate-stories failed:', e);
      res.status(500).json({ ok: false });
    }
  });

  app.post('/admin/rotate-story/:id', async (req, res) => {
    if (!authOk(req)) return res.status(401).json({ error: 'Unauthorized' });
    try {
      const id = String(req.params.id || '');
      const sync = readStorySync();
      if (sync[id]?.ref) await deleteDiscordRef(sync[id].ref);
      delete sync[id];
      writeStorySync(sync);
      await ensureStoryThreadS3(id);
      res.json({ ok: true });
    } catch (e) {
      console.error('rotate-story failed:', e);
      res.status(500).json({ ok: false });
    }
  });

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`📡 Admin API on :${PORT}`);
  });
}

// ---------------------- BOOT ----------------------
client.once('ready', () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  startApi();
  // initial + periodic sync
  setTimeout(() => { syncAllStoriesS3().catch(console.error); }, 3000);
  setInterval(() => { syncAllStoriesS3().catch(console.error); }, 60 * 1000);
});

client.login(TOKEN).catch(err => {
  console.error('❌ Discord login failed:', err);
  process.exit(1);
});
