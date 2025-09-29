// SOAPBOX SERVER — Render disk + legacy voicemail-folder behavior + Forum posting
// Disk root: /opt/render/project/data  (override with DATA_DIR or DATA_ROOT)
// Story voicemail search order:
//   1) Stories/<id>/voicemail/<first .mp3>   (legacy folder)
//   2) metadata.voicemail                    (exact filename in story root)
//   3) Stories/<id>/voicemail.mp3

const express = require("express");
const cors = require("cors");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const archiver = require("archiver");
const { Client, GatewayIntentBits, AttachmentBuilder, ChannelType } = require("discord.js");

// Optional custom poster that knows your threading/format rules
let externalPoster = null;
try { externalPoster = require("./discordPoster"); } catch {}

/* =========================
   CONFIG
   ========================= */
const DATA_ROOT = process.env.DATA_DIR || process.env.DATA_ROOT || "/opt/render/project/data";
const ADMIN_KEY = process.env.SOAPBOX_API_KEY || "changeme";

const DISCORD_TOKEN = process.env.DISCORD_TOKEN || "";

// Channel IDs — fallbacks use what you provided
const BREAKING_NEWS_CHANNEL_ID = process.env.BREAKING_NEWS_CHANNEL_ID || "1407176815285637313";
const CONFESSIONS_CHANNEL_ID   = process.env.CONFESSIONS_CHANNEL_ID   || "1407177292605685932";
const VOICEMAIL_CHANNEL_ID     = process.env.VOICEMAIL_CHANNEL_ID     || "1407177470997696562";
const SPOTLIGHT_CHANNEL_ID     = process.env.SPOTLIGHT_CHANNEL_ID     || "1411392998427856907";

/* =========================
   DISCORD
   ========================= */
const discordClient = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });
if (DISCORD_TOKEN) {
  discordClient.login(DISCORD_TOKEN)
    .then(() => console.log("[Discord] Logged in"))
    .catch(err => console.error("[Discord] Login failed:", err));
} else {
  console.warn("[Discord] No DISCORD_TOKEN set");
}

/* =========================
   APP
   ========================= */
const app = express();
app.use(cors());
app.use(express.json({ limit: "25mb" }));

// Serve the entire disk under /static
app.use("/static", express.static(DATA_ROOT, {
  fallthrough: true,
  setHeaders(res) { res.setHeader("Access-Control-Allow-Origin", "*"); }
}));

const upload = multer({ dest: path.join(DATA_ROOT, "tmp") });

/* =========================
   HELPERS
   ========================= */
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

// Legacy voicemail resolution
function findVoicemailPath(storyId) {
  const dir = storyDirOf(storyId);
  // 1) voicemail folder
  const vmFolder = path.join(dir, "voicemail");
  if (fs.existsSync(vmFolder) && fs.statSync(vmFolder).isDirectory()) {
    const mp3s = (fs.readdirSync(vmFolder) || []).filter(f => /\.mp3$/i.test(f));
    if (mp3s.length >= 1) return path.join(vmFolder, mp3s[0]);
  }
  // 2) metadata.voicemail
  const meta = readStoryMeta(storyId);
  if (meta && typeof meta.voicemail === "string" && meta.voicemail.trim()) {
    const abs = path.join(dir, meta.voicemail.trim());
    if (fs.existsSync(abs)) return abs;
  }
  // 3) default file
  const fallback = path.join(dir, "voicemail.mp3");
  if (fs.existsSync(fallback)) return fallback;
  return null;
}

// Publish one story card to a Text or Forum channel
async function publishStoryToChannel(channelId, story) {
  if (!channelId) throw new Error("No channelId provided");
  const ch = await discordClient.channels.fetch(channelId);
  if (!ch) throw new Error("Discord channel not found");

  const lines = [];
  lines.push(`**${story.title || story.headline || story.id}**`);
  if (story.subtitle) lines.push(story.subtitle);
  if (story.voicemailUrl) lines.push(`🎧 Voicemail: ${story.voicemailUrl}`);
  const content = lines.join("\n");

  // Let your custom poster try first
  if (externalPoster && typeof externalPoster === "function") {
    try { await externalPoster(discordClient, story.id, null, content); return; }
    catch (e) { console.warn("[DiscordPoster] external poster failed, falling back:", e.message); }
  }

  // Text channel
  if (typeof ch.send === "function") {
    await ch.send({ content, ...(story.thumbUrl ? { files: [story.thumbUrl] } : {}) });
    return;
  }

  // Forum: create a post with first message
  if (ch.type === ChannelType.GuildForum && ch.threads && typeof ch.threads.create === "function") {
    await ch.threads.create({
      name: story.title || story.id,
      message: { content, ...(story.thumbUrl ? { files: [story.thumbUrl] } : {}) },
    });
    return;
  }

  throw new Error("Unsupported channel type (no send/threads.create)");
}

/* =========================
   STATIC ALIASES APP EXPECTS
   ========================= */
// Express 5: avoid :rest* pattern; use regex mapping /static/<id>/<rest>
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

/* =========================
   HEALTH
   ========================= */
app.get("/health", (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));

/* =========================
   LINKS / SPOTLIGHTS
   ========================= */
app.get("/links", (_req, res) => {
  // server stores {items:[{title,url,imageKey? or imageUrl?}]}
  res.json(safeReadJson(path.join(DATA_ROOT, "app/links.json"), { items: [] }));
});

app.post("/admin/links", requireAdmin, (req, res) => {
  if (!req.body || typeof req.body !== "object") return res.status(400).json({ error: "Body must be an object" });
  writeJson(path.join(DATA_ROOT, "app/links.json"), req.body);
  res.json({ ok: true });
});

// Spotlights are folders: Spotlights/<Name>/{title.txt,link.txt,<image>}
function readSpotlights() {
  const root = path.join(DATA_ROOT, "Spotlights");
  const out = [];
  if (!fs.existsSync(root)) return out;
  for (const id of fs.readdirSync(root)) {
    const dir = path.join(root, id);
    try {
      const st = fs.statSync(dir);
      if (!st.isDirectory()) continue;
      const titleFile = path.join(dir, "title.txt");
      const linkFile  = path.join(dir, "link.txt");
      if (!fs.existsSync(titleFile) || !fs.existsSync(linkFile)) continue;

      const title = fs.readFileSync(titleFile, "utf8").trim();
      const url   = fs.readFileSync(linkFile, "utf8").trim();

      const img = (fs.readdirSync(dir).find(f => /\.(png|jpe?g|webp)$/i.test(f)) || null);
      const thumb = img ? `/static/Spotlights/${encodeURIComponent(id)}/${encodeURIComponent(img)}` : null;

      out.push({ id, title, url, thumb, date: new Date(st.mtimeMs).toISOString() });
    } catch {}
  }
  // newest first
  out.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  return out;
}

app.get("/spotlight-videos", (_req, res) => res.json(readSpotlights()));

/* =========================
   CONFESSIONS
   ========================= */
app.get("/confessions", (_req, res) => res.json(safeReadJson(path.join(DATA_ROOT, "app/confessions.json"), [])));

app.post("/confessions", async (req, res) => {
  const { text } = req.body || {};
  if (!text) return res.status(400).json({ error: "Confession text required" });
  const file = path.join(DATA_ROOT, "app/confessions.json");
  const arr = safeReadJson(file, []); arr.push({ text, at: new Date().toISOString() });
  writeJson(file, arr);

  if (CONFESSIONS_CHANNEL_ID) {
    try {
      const ch = await discordClient.channels.fetch(CONFESSIONS_CHANNEL_ID);
      if (ch && typeof ch.send === "function") await ch.send(text);
    } catch (e) { console.warn("[Confessions] post failed:", e.message); }
  }
  res.json({ ok: true });
});

/* =========================
   STORIES (LIST)
   ========================= */
app.get("/stories", (_req, res) => {
  try {
    const root = path.join(DATA_ROOT, "Stories");
    if (!fs.existsSync(root)) return res.json([]);
    const out = [];
    for (const id of fs.readdirSync(root)) {
      const dir = path.join(root, id);
      const metaFile = path.join(dir, "metadata.json");
      if (!fs.existsSync(dir) || !fs.existsSync(metaFile)) continue;

      const meta = safeReadJson(metaFile, {});
      const thumbRel = meta.thumbnailYt || meta.youtubeThumbnail || meta.thumbnail || null;
      const thumbUrl = thumbRel ? `/static/Stories/${encodeURIComponent(id)}/${encodeURIComponent(thumbRel)}` : null;

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
    res.json(out);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* =========================
   VOICEMAIL (APP AUTOPLAY)
   ========================= */
app.get("/voicemail/:id", (req, res) => {
  const vmAbs = findVoicemailPath(req.params.id);
  if (!vmAbs) return res.status(404).json({ error: "No voicemail for this story" });
  res.redirect(302, urlFor(vmAbs));
});

/* =========================
   ADMIN: STORY META & THUMBS
   ========================= */
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
      // make this the only active
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

/* =========================
   ADMIN: VOICEMAIL UPLOAD (per story)
   ========================= */
app.post("/admin/story/:id/voicemail", requireAdmin, upload.single("audio"), async (req, res) => {
  try {
    const storyId = req.params.id;
    if (!req.file) return res.status(400).json({ error: "Missing audio" });

    const dir = storyDirOf(storyId); ensureDir(dir);
    const vmFolder = path.join(dir, "voicemail"); ensureDir(vmFolder);

    // Clean old mp3s
    try {
      for (const f of fs.readdirSync(vmFolder)) if (/\.mp3$/i.test(f)) fs.unlinkSync(path.join(vmFolder, f));
    } catch {}

    const mp3Name = (req.file.originalname && /\.mp3$/i.test(req.file.originalname)) ? req.file.originalname : "voicemail.mp3";
    const mp3Path = path.join(vmFolder, mp3Name);
    fs.renameSync(req.file.path, mp3Path);

    // (Optional) build an mp4 teaser
    const makeVoicemailVideo = require("./makeVoicemailVideo");
    const meta = readStoryMeta(storyId);
    const ytThumbRel = meta.thumbnailYt || meta.youtubeThumbnail || null;
    const ytThumbAbs = ytThumbRel ? path.join(dir, ytThumbRel) : null;
    const mp4Path = path.join(dir, (mp3Name.replace(/\.[^.]+$/, "") || "voicemail") + ".mp4");
    await makeVoicemailVideo(mp3Path, mp4Path, ytThumbAbs && fs.existsSync(ytThumbAbs) ? ytThumbAbs : undefined);

    // Fallback post if externalPoster not available
    try {
      await publishStoryToChannel(VOICEMAIL_CHANNEL_ID, {
        id: storyId,
        title: `Voicemail for ${storyId}`,
        subtitle: "",
        thumbUrl: ytThumbAbs ? urlFor(ytThumbAbs) : null,
        voicemailUrl: urlFor(mp3Path),
      });
    } catch (e) {
      console.warn("[Voicemail fallback post] failed:", e.message);
    }

    res.json({ ok: true, mp3: urlFor(mp3Path), mp4: urlFor(mp4Path) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/* =========================
   ADMIN: WITNESS (per story)
   ========================= */
app.post("/admin/story/:id/witness", requireAdmin, upload.single("video"), async (req, res) => {
  try {
    const storyId = req.params.id;
    if (!req.file) return res.status(400).json({ error: "Missing video" });

    const wtDir = path.join(storyDirOf(storyId), "witnesses"); ensureDir(wtDir);
    const base = Date.now().toString();
    const outPath = path.join(wtDir, `${base}.mp4`);
    fs.renameSync(req.file.path, outPath);

    // post raw file into Breaking News thread/post
    await publishStoryToChannel(BREAKING_NEWS_CHANNEL_ID, {
      id: storyId,
      title: `Witness Video — ${storyId}`,
      subtitle: "",
      thumbUrl: null,
      voicemailUrl: null,
    });

    res.json({ ok: true, url: urlFor(outPath) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/* =========================
   ADMIN: ROTATE STORIES
   ========================= */
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

/* =========================
   ADMIN: EXPORT (ZIP originals)
   ========================= */
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

      const vmMp4 = path.join(dir, ((path.basename(vmAbs || "voicemail.mp3")).replace(/\.[^.]+$/, "") + ".mp4"));
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

/* =========================
   ADMIN: PUBLISH TO DISCORD
   ========================= */
// Active story only
app.post("/admin/publish-stories", requireAdmin, async (req, res) => {
  try {
    const channelId = (req.body && req.body.channelId) || BREAKING_NEWS_CHANNEL_ID;
    const stories = safeReadJson(path.join(DATA_ROOT, "app/stories.json"), null) || (() => {
      const out = [];
      const root = path.join(DATA_ROOT, "Stories");
      if (!fs.existsSync(root)) return out;
      for (const id of fs.readdirSync(root)) {
        const dir = path.join(root, id);
        const meta = safeReadJson(path.join(dir, "metadata.json"), { id });
        if (!meta.active) continue;
        const thumbRel = meta.thumbnailYt || meta.youtubeThumbnail || meta.thumbnail || null;
        const thumbUrl = thumbRel ? `/static/Stories/${encodeURIComponent(id)}/${encodeURIComponent(thumbRel)}` : null;
        const vmAbs = findVoicemailPath(id);
        const voicemailUrl = vmAbs ? urlFor(vmAbs) : null;
        out.push({ id, title: meta.title || id, subtitle: meta.subtitle || "", thumbUrl, voicemailUrl });
      }
      return out;
    })();

    if (!stories.length) return res.json({ ok: true, stories: 0, activePosted: 0 });
    await publishStoryToChannel(channelId, stories[0]);
    res.json({ ok: true, stories: stories.length, activePosted: 1 });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// All stories
app.post("/admin/publish-stories-all", requireAdmin, async (req, res) => {
  try {
    const channelId = (req.body && req.body.channelId) || BREAKING_NEWS_CHANNEL_ID;
    const root = path.join(DATA_ROOT, "Stories");
    if (!fs.existsSync(root)) return res.json({ ok: true, stories: 0, posted: 0 });

    const stories = [];
    for (const id of fs.readdirSync(root)) {
      const dir = path.join(root, id);
      const meta = safeReadJson(path.join(dir, "metadata.json"), { id });
      const thumbRel = meta.thumbnailYt || meta.youtubeThumbnail || meta.thumbnail || null;
      const thumbUrl = thumbRel ? `/static/Stories/${encodeURIComponent(id)}/${encodeURIComponent(thumbRel)}` : null;
      const vmAbs = findVoicemailPath(id);
      const voicemailUrl = vmAbs ? urlFor(vmAbs) : null;
      stories.push({ id, title: meta.title || id, subtitle: meta.subtitle || "", thumbUrl, voicemailUrl });
    }

    for (const s of stories) {
      await publishStoryToChannel(channelId, s);
    }
    res.json({ ok: true, stories: stories.length, posted: stories.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* =========================
   404
   ========================= */
app.use((_req, res) => res.status(404).json({ error: "Not found" }));

/* =========================
   START
   ========================= */
const PORT = process.env.PORT || 3030;
app.listen(PORT, () => {
  console.log("[Server] Listening on", PORT);
  console.log("[Server] DATA_ROOT =", DATA_ROOT);
  console.log("[Discord] BreakingNews:", BREAKING_NEWS_CHANNEL_ID,
              "Confessions:", CONFESSIONS_CHANNEL_ID,
              "Voicemails:", VOICEMAIL_CHANNEL_ID,
              "Spotlight:", SPOTLIGHT_CHANNEL_ID);
});
