// SOAPBOX SERVER — stable, forum-safe, legacy voicemail folder, single-attachment posts

const express = require("express");
const cors = require("cors");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const archiver = require("archiver");
const {
  Client,
  GatewayIntentBits,
  AttachmentBuilder,
  ChannelType,
} = require("discord.js");

let externalPoster = null;
try { externalPoster = require("./discordPoster"); } catch (_) {}

let makeVoicemailVideo = null;
try { makeVoicemailVideo = require("./makeVoicemailVideo"); } catch (_) {}

// ---------- CONFIG ----------
const DATA_ROOT = process.env.DATA_DIR || process.env.DATA_ROOT || "/opt/render/project/data";
const ADMIN_KEY  = process.env.SOAPBOX_API_KEY || "changeme";

// Discord envs
const DISCORD_TOKEN            = process.env.DISCORD_TOKEN || "";
const CONFESSIONS_CHANNEL_ID   = process.env.CONFESSIONS_CHANNEL_ID || "";
const SPOTLIGHT_CHANNEL_ID     = process.env.SPOTLIGHT_CHANNEL_ID || "";
const VOICEMAIL_CHANNEL_ID     = process.env.VOICEMAIL_CHANNEL_ID || "";
const BREAKING_NEWS_CHANNEL_ID = process.env.BREAKING_NEWS_CHANNEL_ID || ""; // forum channel preferred

// Absolute origin for embed images
const PUBLIC_BASE = process.env.PUBLIC_BASE || "https://soapbox-server.onrender.com";

// ---------- DISCORD ----------
const discordClient = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
});
if (DISCORD_TOKEN) {
  discordClient.login(DISCORD_TOKEN)
    .then(() => console.log("[Discord] Logged in"))
    .catch(err => console.error("[Discord] Login failed:", err));
} else {
  console.warn("[Discord] No DISCORD_TOKEN set");
}

// ---------- APP ----------
const app = express();
app.use(cors());
app.use(express.json({ limit: "25mb" }));

// Serve the entire Render disk at /static
app.use("/static", express.static(DATA_ROOT, {
  fallthrough: true,
  setHeaders(res) { res.setHeader("Access-Control-Allow-Origin", "*"); }
}));

const upload = multer({ dest: path.join(DATA_ROOT, "tmp") });

// ---------- HELPERS ----------
function ensureDir(p) { if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }); }
function safeReadJson(file, fallback) {
  try { if (!fs.existsSync(file)) return fallback; return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { return fallback; }
}
function writeJson(file, obj) { ensureDir(path.dirname(file)); fs.writeFileSync(file, JSON.stringify(obj, null, 2)); }

function requireAdmin(req, res, next) {
  const key = req.header("x-soapbox-key");
  if (ADMIN_KEY && key === ADMIN_KEY) return next();
  return res.status(401).json({ error: "Unauthorized" });
}
function storyDirOf(id) { return path.join(DATA_ROOT, "Stories", id); }
function urlFor(absPath) { return "/static" + absPath.replace(DATA_ROOT, "").replace(/\\/g, "/"); }

function readStoryMeta(id) {
  return safeReadJson(path.join(DATA_ROOT, "Stories", id, "metadata.json"), { id });
}

// ---- LEGACY: find voicemail MP3 like it used to ----
function findVoicemailPath(storyId) {
  const dir = storyDirOf(storyId);

  // 1) Folder “voicemail” with one .mp3 (or take first)
  const vmFolder = path.join(dir, "voicemail");
  if (fs.existsSync(vmFolder) && fs.statSync(vmFolder).isDirectory()) {
    const mp3s = (fs.readdirSync(vmFolder) || []).filter(f => /\.mp3$/i.test(f)).sort();
    if (mp3s.length >= 1) return path.join(vmFolder, mp3s[0]);
  }

  // 2) metadata.voicemail
  const meta = readStoryMeta(storyId);
  if (meta && typeof meta.voicemail === "string" && meta.voicemail.trim()) {
    const abs = path.join(dir, meta.voicemail.trim());
    if (fs.existsSync(abs)) return abs;
  }

  // 3) default file in story root
  const fallback = path.join(dir, "voicemail.mp3");
  if (fs.existsSync(fallback)) return fallback;

  return null;
}

// ---------- STATIC ALIASES THE APP EXPECTS ----------
// Avoid Express 5 param wildcards; use regex:
app.get(/^\/static\/([^/]+)\/(.+)$/, (req, res, next) => {
  const storyId = req.params[0];
  const restRel = req.params[1];
  const file = path.join(storyDirOf(storyId), restRel);
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) return next();
  res.sendFile(file);
});

app.get("/static/:storyId/metadata.json", (req, res) => {
  const file = path.join(storyDirOf(req.params.storyId), "metadata.json");
  if (!fs.existsSync(file)) return res.status(404).json({ error: "Not found" });
  res.type("application/json").send(fs.readFileSync(file, "utf8"));
});

// ---------- HEALTH ----------
app.get("/health", (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// ---------- LINKS / SPOTLIGHTS ----------
app.get("/links", (_req, res) => {
  // structure: { items: [{title, url, imageKey?, imageUrl?}, ...] }
  res.json(safeReadJson(path.join(DATA_ROOT, "app/links.json"), { items: [] }));
});

app.get("/spotlights", (_req, res) => res.json(safeReadJson(path.join(DATA_ROOT, "app/spotlights.json"), [])));

app.post("/admin/links", requireAdmin, (req, res) => {
  // Expect { items: [...] }
  if (!req.body || typeof req.body !== "object" || !Array.isArray(req.body.items)) {
    return res.status(400).json({ error: "Body must be { items: LinkItem[] }" });
  }
  writeJson(path.join(DATA_ROOT, "app/links.json"), req.body);
  res.json({ ok: true, count: req.body.items.length });
});

app.post("/admin/spotlights", requireAdmin, async (req, res) => {
  if (!Array.isArray(req.body)) return res.status(400).json({ error: "Body must be an array" });
  writeJson(path.join(DATA_ROOT, "app/spotlights.json"), req.body);
  if (SPOTLIGHT_CHANNEL_ID) {
    try {
      const ch = await discordClient.channels.fetch(SPOTLIGHT_CHANNEL_ID);
      if (ch) await ch.send("✅ Spotlights updated");
    } catch (_) {}
  }
  res.json({ ok: true, count: req.body.length });
});

// App-form spotlights -> Discord (no app posting)
app.post("/spotlights", async (req, res) => {
  try {
    const { name, link, notes } = req.body || {};
    if (!name || !link) return res.status(400).json({ error: "Missing name/link" });
    if (!SPOTLIGHT_CHANNEL_ID) return res.status(400).json({ error: "SPOTLIGHT_CHANNEL_ID not set" });
    const ch = await discordClient.channels.fetch(SPOTLIGHT_CHANNEL_ID);
    if (!ch) return res.status(500).json({ error: "Discord channel not found" });

    const content =
      `🧠 Spotlight submission\n` +
      `**Name:** ${name}\n` +
      `**Link:** ${link}\n` +
      (notes ? `**Notes:** ${notes}\n` : "");
    await ch.send({ content });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

// ---------- CONFESSIONS ----------
app.get("/confessions", (_req, res) => res.json(safeReadJson(path.join(DATA_ROOT, "app/confessions.json"), [])));

app.post("/confessions", async (req, res) => {
  const { text } = req.body || {};
  if (!text) return res.status(400).json({ error: "Confession text required" });
  const file = path.join(DATA_ROOT, "app/confessions.json");
  const arr = safeReadJson(file, []); arr.push({ text, at: new Date().toISOString() });
  writeJson(file, arr);
  if (CONFESSIONS_CHANNEL_ID) {
    try { const ch = await discordClient.channels.fetch(CONFESSIONS_CHANNEL_ID); if (ch) await ch.send(text); } catch {}
  }
  res.json({ ok: true });
});

// ---------- STORIES (LIST) ----------
app.get("/stories", (_req, res) => {
  try {
    const root = path.join(DATA_ROOT, "Stories");
    if (!fs.existsSync(root)) return res.json([]);
    const out = [];
    for (const id of fs.readdirSync(root)) {
      const dir = path.join(root, id);
      const metaFile = path.join(dir, "metadata.json");
      if (fs.existsSync(dir) && fs.existsSync(metaFile)) {
        const meta = safeReadJson(metaFile, {});
        const thumbRel = meta.thumbnailYt || meta.youtubeThumbnail || meta.thumbnail || null;
        const thumbUrl = thumbRel ? `/static/Stories/${id}/${encodeURIComponent(path.basename(thumbRel))}` : null;

        const vmAbs = findVoicemailPath(id);
        const voicemailUrl = vmAbs ? urlFor(vmAbs) : null;

        out.push({
          id,
          title: meta.title || id,
          subtitle: meta.subtitle || "",
          active: !!meta.active,
          prompts: Array.isArray(meta.prompts) ? meta.prompts : [],
          thumbUrl,
          voicemailUrl
        });
      }
    }
    res.json(out);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- VOICEMAIL (APP AUTOPLAY/REDIRECT) ----------
app.get("/voicemail/:id", (req, res) => {
  const vmAbs = findVoicemailPath(req.params.id);
  if (!vmAbs) return res.status(404).json({ error: "No voicemail for this story" });
  res.redirect(302, urlFor(vmAbs));
});

// ---------- ADMIN: STORY META & THUMBS ----------
app.post("/admin/story/:id/meta", requireAdmin, (req, res) => {
  try {
    const id = req.params.id;
    const file = path.join(storyDirOf(id), "metadata.json");
    const current = safeReadJson(file, { id });
    const next = { ...current };

    if (typeof req.body.title === "string") next.title = req.body.title;
    if (typeof req.body.subtitle === "string") next.subtitle = req.body.subtitle;
    if (Array.isArray(req.body.prompts)) next.prompts = req.body.prompts;
    if (typeof req.body.voicemail === "string") next.voicemail = req.body.voicemail;

    if (typeof req.body.active === "boolean" && req.body.active) {
      const root = path.join(DATA_ROOT, "Stories");
      if (fs.existsSync(root)) {
        for (const otherId of fs.readdirSync(root)) {
          const mf = path.join(root, otherId, "metadata.json");
          if (fs.existsSync(mf)) {
            const m = safeReadJson(mf, { id: otherId });
            m.active = otherId === id;
            writeJson(mf, m);
          }
        }
      }
      next.active = true;
    } else if (typeof req.body.active === "boolean") {
      next.active = req.body.active;
    }

    writeJson(file, next);
    res.json({ ok: true, meta: next });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/admin/story/:id/thumbnail", requireAdmin, upload.single("file"), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "Missing file" });
    const id = req.params.id;
    const dir = storyDirOf(id); ensureDir(dir);
    const filename = req.file.originalname || "thumbnail.png";
    const dest = path.join(dir, filename);
    fs.renameSync(req.file.path, dest);

    const metaFile = path.join(dir, "metadata.json");
    const meta = safeReadJson(metaFile, { id });
    meta.thumbnail = filename;
    writeJson(metaFile, meta);

    res.json({ ok: true, thumbnail: urlFor(dest) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/admin/story/:id/thumbnail-yt", requireAdmin, upload.single("file"), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "Missing file" });
    const id = req.params.id;
    const dir = storyDirOf(id); ensureDir(dir);
    const filename = req.file.originalname || "thumbnail-yt.png";
    const dest = path.join(dir, filename);
    fs.renameSync(req.file.path, dest);

    const metaFile = path.join(dir, "metadata.json");
    const meta = safeReadJson(metaFile, { id });
    meta.thumbnailYt = filename;
    writeJson(metaFile, meta);

    res.json({ ok: true, thumbnailYt: urlFor(dest) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- ADMIN: VOICEMAIL UPLOAD (per story)
app.post("/admin/story/:id/voicemail", requireAdmin, upload.single("audio"), async (req, res) => {
  try {
    const storyId = req.params.id;
    if (!req.file) return res.status(400).json({ error: "Missing audio" });

    const dir = storyDirOf(storyId); ensureDir(dir);
    const vmFolder = path.join(dir, "voicemail"); ensureDir(vmFolder);

    // Clear old mp3s to keep legacy behavior simple
    try {
      for (const f of fs.readdirSync(vmFolder)) if (/\.mp3$/i.test(f)) fs.unlinkSync(path.join(vmFolder, f));
    } catch {}

    const mp3Name = (req.file.originalname && /\.mp3$/i.test(req.file.originalname)) ? req.file.originalname : "voicemail.mp3";
    const mp3Path = path.join(vmFolder, mp3Name);
    fs.renameSync(req.file.path, mp3Path);

    // Try to create an MP4 if ffmpeg is available (non-fatal if not)
    let mp4Path = path.join(dir, (mp3Name.replace(/\.[^.]+$/, "") || "voicemail") + ".mp4");
    const meta = readStoryMeta(storyId);
    const thumbRel = meta.thumbnailYt || meta.youtubeThumbnail || meta.thumbnail || null;
    const thumbAbs = thumbRel ? path.join(dir, thumbRel) : null;

    if (makeVoicemailVideo) {
      try {
        await makeVoicemailVideo(mp3Path, mp4Path, (thumbAbs && fs.existsSync(thumbAbs)) ? thumbAbs : undefined);
      } catch (e) {
        console.warn("[FFmpeg] Skipping MP4 creation:", e.message || e);
        mp4Path = null;
      }
    } else {
      mp4Path = null;
    }

    res.json({ ok: true, mp3: urlFor(mp3Path), mp4: mp4Path ? urlFor(mp4Path) : null });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ---------- ADMIN: WITNESS (per story) ----------
async function postFileToDiscord(storyId, absFilePath, content = "") {
  if (externalPoster && typeof externalPoster === "function") {
    try { return await externalPoster(discordClient, storyId, absFilePath, content); }
    catch (e) { console.warn("[DiscordPoster] external poster failed, falling back:", e.message || e); }
  }
  if (!VOICEMAIL_CHANNEL_ID) throw new Error("VOICEMAIL_CHANNEL_ID not set");
  const ch = await discordClient.channels.fetch(VOICEMAIL_CHANNEL_ID);
  if (!ch) throw new Error("Discord channel not found");
  const file = new AttachmentBuilder(absFilePath);
  return ch.send({ content, files: [file] });
}

app.post("/admin/story/:id/witness", requireAdmin, upload.single("video"), async (req, res) => {
  try {
    const storyId = req.params.id;
    if (!req.file) return res.status(400).json({ error: "Missing video" });

    const wtDir = path.join(storyDirOf(storyId), "witnesses"); ensureDir(wtDir);
    const outPath = path.join(wtDir, `${Date.now()}.mp4`);
    fs.renameSync(req.file.path, outPath);

    await postFileToDiscord(storyId, outPath, `🎥 Witness submission — **${storyId}**`);
    res.json({ ok: true, url: urlFor(outPath) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ---------- ADMIN: ROTATE STORIES ----------
function allStoryIds() {
  const root = path.join(DATA_ROOT, "Stories");
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root).filter(id => fs.existsSync(path.join(root, id, "metadata.json")));
}
function readMeta(id) { return safeReadJson(path.join(DATA_ROOT, "Stories", id, "metadata.json"), { id }); }
function writeMeta(id, meta) { writeJson(path.join(DATA_ROOT, "Stories", id, "metadata.json"), { id, ...meta }); }

function setActive(targetId) {
  const ids = allStoryIds();
  if (!ids.includes(targetId)) throw new Error(`Story '${targetId}' not found`);
  let activeMeta = null;
  ids.forEach(id => {
    const m = readMeta(id);
    m.active = id === targetId;
    writeMeta(id, m);
    if (m.active) activeMeta = m;
  });
  return { activeId: targetId, meta: activeMeta, ids };
}

app.post("/admin/rotate-story/:id", requireAdmin, (req, res) => {
  try { res.json({ ok: true, ...setActive(req.params.id) }); }
  catch (err) { res.status(400).json({ error: err.message }); }
});
app.post("/admin/rotate-stories", requireAdmin, (req, res) => {
  try {
    const ids = allStoryIds(); if (!ids.length) return res.status(400).json({ error: "No stories" });
    const curIdx = ids.findIndex(id => readMeta(id).active);
    const next = curIdx >= 0 ? (curIdx + 1) % ids.length : 0;
    res.json({ ok: true, ...setActive(ids[next]) });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// ---------- ADMIN: EXPORT (ZIP originals) ----------
app.get("/admin/export", requireAdmin, (req, res) => {
  try {
    const story = (req.query.story || "").trim();
    const root = path.join(DATA_ROOT, "Stories");
    if (!fs.existsSync(root)) return res.status(400).json({ error: "No stories directory" });

    const filename = story
      ? `export-${story}-${new Date().toISOString().split("T")[0]}.zip`
      : `export-all-${new Date().toISOString().split("T")[0]}.zip`;

    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);

    const archive = archiver("zip", { zlib: { level: 9 } });
    archive.on("error", err => { throw err; });
    archive.pipe(res);

    const addStory = (id) => {
      const dir = path.join(root, id);
      const metaFile = path.join(dir, "metadata.json");
      if (!fs.existsSync(metaFile)) return;

      archive.file(metaFile, { name: `${id}/metadata.json` });

      const meta = safeReadJson(metaFile, {});
      const thumbs = [meta.thumbnail, meta.thumbnailYt, meta.youtubeThumbnail]
        .filter(Boolean)
        .map(fn => path.join(dir, fn))
        .filter(p => fs.existsSync(p));
      thumbs.forEach((p, i) => archive.file(p, { name: `${id}/thumb-${i+1}${path.extname(p)}` }));

      const vmAbs = findVoicemailPath(id);
      if (vmAbs) archive.file(vmAbs, { name: `${id}/${path.basename(vmAbs)}` });

      // include any pre-rendered MP4 if present
      const mp4Name = vmAbs ? (path.basename(vmAbs).replace(/\.[^.]+$/, "") + ".mp4") : "voicemail.mp4";
      const vmMp4 = path.join(dir, mp4Name);
      if (fs.existsSync(vmMp4)) archive.file(vmMp4, { name: `${id}/${path.basename(vmMp4)}` });

      const witDir = path.join(dir, "witnesses");
      if (fs.existsSync(witDir)) archive.directory(witDir, `${id}/witnesses`);
    };

    if (story) addStory(story); else for (const id of fs.readdirSync(root)) addStory(id);
    archive.finalize();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ---------- OPTIONAL: DISCORD VOICEMAIL INBOX ----------
app.post("/admin/discord/voicemail", requireAdmin, upload.single("audio"), async (req, res) => {
  try {
    if (!VOICEMAIL_CHANNEL_ID) return res.status(400).json({ error: "VOICEMAIL_CHANNEL_ID not set" });
    if (!req.file) return res.status(400).json({ error: "Missing audio" });

    const inboxDir = path.join(DATA_ROOT, "inbox", "discord-voicemails"); ensureDir(inboxDir);
    const postedDir = path.join(DATA_ROOT, "posted", "discord-voicemails"); ensureDir(postedDir);

    const base = Date.now().toString();
    const mp3Path = path.join(inboxDir, `${base}.mp3`);
    fs.renameSync(req.file.path, mp3Path);

    // Try to produce an MP4 if ffmpeg exists; if not, still post the MP3
    let mp4Path = path.join(inboxDir, `${base}.mp4`);
    const defaultThumb = path.join(DATA_ROOT, "app", "megaphone.png");
    if (makeVoicemailVideo && fs.existsSync(defaultThumb)) {
      try { await makeVoicemailVideo(mp3Path, mp4Path, defaultThumb); }
      catch (e) { console.warn("[FFmpeg] Skipping MP4 creation:", e.message || e); mp4Path = null; }
    } else { mp4Path = null; }

    const ch = await discordClient.channels.fetch(VOICEMAIL_CHANNEL_ID);
    if (!ch) return res.status(500).json({ error: "Discord channel not found" });

    // Single attachment only (prefer MP3 here so Discord renders audio inline)
    const files = [new AttachmentBuilder(mp3Path)];
    await ch.send({ content: "📬 New voicemail", files });

    fs.renameSync(mp3Path, path.join(postedDir, `${base}.mp3`));
    if (mp4Path && fs.existsSync(mp4Path)) fs.renameSync(mp4Path, path.join(postedDir, `${base}.mp4`));

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ---------- THREAD MAP (optional) ----------
function readThreadMap() {
  return safeReadJson(path.join(DATA_ROOT, "app", "threads.json"), {}); // { StoryId: "discordThreadId" }
}

// ---------- DISCORD PUBLISH HELPERS ----------
function resolveStoryAssets(storyId) {
  const dir = storyDirOf(storyId);
  const meta = readStoryMeta(storyId);
  const title = (meta.title || storyId).toString();
  const sub   = (meta.subtitle || "").toString();

  const thumbRel  = meta.thumbnailYt || meta.youtubeThumbnail || meta.thumbnail || null;
  const thumbFile = thumbRel ? path.join(dir, thumbRel) : null;

  // Prefer MP4 (if pre-rendered), else MP3 from legacy voicemail folder
  const vmMp3 = findVoicemailPath(storyId);
  let mediaFile = null;
  if (vmMp3 && fs.existsSync(vmMp3)) {
    const mp4Guess = path.join(dir, path.basename(vmMp3).replace(/\.[^.]+$/, "") + ".mp4");
    mediaFile = fs.existsSync(mp4Guess) ? mp4Guess : vmMp3;
  }

  return {
    title,
    sub,
    thumbFile: (thumbFile && fs.existsSync(thumbFile)) ? thumbFile : null,
    mediaFile
  };
}

async function ensureForumThread(channelId, storyId, titleText, messageContent, files, embeds) {
  const ch = await discordClient.channels.fetch(channelId);
  if (!ch) throw new Error("Breaking News channel not found");
  if (ch.type === ChannelType.GuildForum) {
    return ch.threads.create({
      name: titleText,
      message: { content: messageContent, files, embeds }
    });
  } else {
    return ch.send({ content: messageContent, files, embeds });
  }
}

async function postToExistingThread(threadId, content, files, embeds) {
  const thread = await discordClient.channels.fetch(threadId);
  if (!thread) throw new Error("Thread not found");
  return thread.send({ content, files, embeds });
}

async function publishStoryOnce(storyId, channelIdOverride) {
  if (externalPoster && typeof externalPoster === "function") {
    try { return await externalPoster(discordClient, storyId); }
    catch (e) { console.warn("[DiscordPoster] external poster failed:", e.message || e); }
  }

  const { title, sub, thumbFile, mediaFile } = resolveStoryAssets(storyId);

  const headline = (title || storyId).trim();
  const subline  = (sub || "").trim();
  const content  = subline ? `**${headline}**\n${subline}` : `**${headline}**`;

  // ONE media file only (MP4 or MP3) to avoid duplicate-render issues
  const files = [];
  if (mediaFile) files.push(new AttachmentBuilder(mediaFile));

  // Thumbnail shown via embed image (not as a second attachment)
  const embeds = [];
  if (thumbFile) {
    const thumbUrl = PUBLIC_BASE + urlFor(thumbFile);
    embeds.push({ image: { url: thumbUrl } });
  }

  const map = readThreadMap();
  const mappedThread = map[storyId];

  const targetChannelId = channelIdOverride || BREAKING_NEWS_CHANNEL_ID || VOICEMAIL_CHANNEL_ID;
  if (!targetChannelId) throw new Error("BREAKING_NEWS_CHANNEL_ID not set and no override provided");

  if (mappedThread) {
    return await postToExistingThread(mappedThread, content, files, embeds);
  } else {
    return await ensureForumThread(targetChannelId, storyId, headline, content, files, embeds);
  }
}

async function publishAllActiveStories(channelIdOverride) {
  const ids = allStoryIds().filter(id => readMeta(id).active);
  const results = [];
  for (const id of ids) {
    try {
      const r = await publishStoryOnce(id, channelIdOverride);
      results.push({ id, ok: true, ref: r.id || null });
    } catch (e) {
      results.push({ id, ok: false, error: e.message || String(e) });
    }
  }
  return results;
}

// ---------- ADMIN: PUBLISH ----------
app.post("/admin/publish-stories-all", requireAdmin, async (req, res) => {
  try {
    const override = (req.body && req.body.channelId) ? String(req.body.channelId) : "";
    const results = await publishAllActiveStories(override);
    res.json({ ok: true, results });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || String(e) });
  }
});

// (kept for compatibility if you were using it previously)
app.post("/admin/publish-stories", requireAdmin, async (req, res) => {
  try {
    const override = (req.body && req.body.channelId) ? String(req.body.channelId) : "";
    const results = await publishAllActiveStories(override);
    res.json({ ok: true, results });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || String(e) });
  }
});

// ---------- DEBUG: what will be attached ----------
app.get("/admin/debug/story/:id", requireAdmin, (req, res) => {
  const id = req.params.id;
  const dir = storyDirOf(id);
  const meta = readStoryMeta(id);
  const vmMp3 = findVoicemailPath(id);
  const vmMp3Size = (vmMp3 && fs.existsSync(vmMp3)) ? fs.statSync(vmMp3).size : 0;

  const thumbRel = meta.thumbnailYt || meta.youtubeThumbnail || meta.thumbnail || null;
  const thumbFile = thumbRel ? path.join(dir, thumbRel) : null;
  const thumbSize = (thumbFile && fs.existsSync(thumbFile)) ? fs.statSync(thumbFile).size : 0;

  res.json({
    id,
    dir,
    title: meta.title || id,
    subtitle: meta.subtitle || "",
    voicemailMp3: vmMp3 || null,
    voicemailMp3Bytes: vmMp3Size,
    thumbnail: thumbFile || null,
    thumbnailBytes: thumbSize
  });
});

// ---------- 404 ----------
app.use((_req, res) => res.status(404).json({ error: "Not found" }));

// ---------- START ----------
const PORT = process.env.PORT || 3030;
app.listen(PORT, () => {
  console.log("[Server] Listening on", PORT);
  console.log("[Server] DATA_ROOT =", DATA_ROOT);
});
