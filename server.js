// SOAPBOX SERVER — stable routes + Discord posting + legacy voicemail folder

const express = require("express");
const cors = require("cors");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const archiver = require("archiver");
const { Client, GatewayIntentBits, AttachmentBuilder } = require("discord.js");

// Optional per-story discorder
let externalPoster = null;
try { externalPoster = require("./discordPoster"); } catch (_) {}

// Optional ffmpeg video maker
let makeVoicemailVideo = null;
try { makeVoicemailVideo = require("./makeVoicemailVideo"); } catch (_) {}

// ---------- CONFIG ----------
const DATA_ROOT = process.env.DATA_DIR || process.env.DATA_ROOT || "/opt/render/project/data";
const ADMIN_KEY  = process.env.SOAPBOX_API_KEY || "changeme";

const DISCORD_TOKEN              = process.env.DISCORD_TOKEN              || "";
const BREAKING_NEWS_CHANNEL_ID   = process.env.BREAKING_NEWS_CHANNEL_ID   || "";
const CONFESSIONS_CHANNEL_ID     = process.env.CONFESSIONS_CHANNEL_ID     || "";
const SPOTLIGHT_CHANNEL_ID       = process.env.SPOTLIGHT_CHANNEL_ID       || "";
const VOICEMAIL_CHANNEL_ID       = process.env.VOICEMAIL_CHANNEL_ID       || ""; // generic fallback

// ---------- DISCORD ----------
const discordClient = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });
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

// Static: serve entire persistent disk at /static
app.use("/static", express.static(DATA_ROOT, {
  fallthrough: true,
  setHeaders(res) { res.setHeader("Access-Control-Allow-Origin", "*"); }
}));

const upload = multer({ dest: path.join(DATA_ROOT, "tmp") });

// ---------- HELPERS ----------
const ensureDir = (p) => { if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }); };
const safeReadJson = (file, fallback) => {
  try { if (!fs.existsSync(file)) return fallback; return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { return fallback; }
};
const writeJson = (file, obj) => { ensureDir(path.dirname(file)); fs.writeFileSync(file, JSON.stringify(obj, null, 2)); };

function requireAdmin(req, res, next) {
  const key = req.header("x-soapbox-key");
  if (ADMIN_KEY && key === ADMIN_KEY) return next();
  return res.status(401).json({ error: "Unauthorized" });
}
const storyDirOf = (id) => path.join(DATA_ROOT, "Stories", id);
const urlFor = (absPath) => "/static" + absPath.replace(DATA_ROOT, "").replace(/\\/g, "/");

function readStoryMeta(id) {
  return safeReadJson(path.join(DATA_ROOT, "Stories", id, "metadata.json"), { id });
}

// Legacy voicemail file resolution
function findVoicemailPath(storyId) {
  const dir = storyDirOf(storyId);

  // 1) /voicemail folder (first .mp3)
  const vmFolder = path.join(dir, "voicemail");
  if (fs.existsSync(vmFolder) && fs.statSync(vmFolder).isDirectory()) {
    const mp3s = (fs.readdirSync(vmFolder) || []).filter(f => /\.mp3$/i.test(f));
    if (mp3s.length) return path.join(vmFolder, mp3s[0]);
  }

  // 2) metadata.voicemail
  const meta = readStoryMeta(storyId);
  if (meta && typeof meta.voicemail === "string" && meta.voicemail.trim()) {
    const abs = path.join(dir, meta.voicemail.trim());
    if (fs.existsSync(abs)) return abs;
  }

  // 3) fallback file in story root
  const fallback = path.join(dir, "voicemail.mp3");
  if (fs.existsSync(fallback)) return fallback;

  return null;
}

function listStories() {
  const root = path.join(DATA_ROOT, "Stories");
  if (!fs.existsSync(root)) return [];

  const out = [];
  for (const id of fs.readdirSync(root)) {
    const dir = path.join(root, id);
    const metaFile = path.join(dir, "metadata.json");
    if (!fs.existsSync(dir) || !fs.existsSync(metaFile)) continue;

    const meta = safeReadJson(metaFile, {});
    const thumbRel = meta.thumbnailYt || meta.youtubeThumbnail || meta.thumbnail || null;
    const thumbUrl = thumbRel ? `/static/Stories/${id}/${thumbRel}` : null;

    const vmAbs = findVoicemailPath(id);
    const voicemailUrl = vmAbs ? urlFor(vmAbs) : null;

    out.push({
      id,
      title: meta.title || meta.headline || id,
      subtitle: meta.subtitle || "",
      active: !!meta.active,
      prompts: Array.isArray(meta.prompts) ? meta.prompts : [],
      thumbUrl,
      voicemailUrl,
      youtubeId: meta.youtubeId || meta.youtube || null
    });
  }
  return out;
}

async function postBreakingNewsCard(story) {
  // Prefer externalPoster if present (thread routing, formatting)
  if (externalPoster && typeof externalPoster === "function") {
    try {
      const maybePath = story.voicemailUrl && story.voicemailUrl.startsWith("/static")
        ? path.join(DATA_ROOT, story.voicemailUrl.replace(/^\/static/, ""))
        : null;
      if (maybePath && fs.existsSync(maybePath)) {
        return await externalPoster(discordClient, story.id, maybePath,
          `**${story.title}**\n${story.subtitle || ""}\n\n🎧 Voicemail: ${process.env.PUBLIC_URL || ""}${story.voicemailUrl}`);
      }
    } catch (e) {
      console.warn("[DiscordPoster] external poster failed, falling back:", e.message);
    }
  }

  if (!BREAKING_NEWS_CHANNEL_ID && !VOICEMAIL_CHANNEL_ID) {
    throw new Error("No BREAKING_NEWS_CHANNEL_ID or VOICEMAIL_CHANNEL_ID configured.");
  }
  const channelId = BREAKING_NEWS_CHANNEL_ID || VOICEMAIL_CHANNEL_ID;
  const ch = await discordClient.channels.fetch(channelId);
  if (!ch) throw new Error("Discord channel not found");

  // Compose content
  const lines = [
    `**${story.title}**`,
    story.subtitle || "",
    story.voicemailUrl ? `🎧 Voicemail: ${process.env.PUBLIC_URL || ""}${story.voicemailUrl}` : ""
  ].filter(Boolean);
  const content = lines.join("\n");

  // Attach thumbnail if it's a file on disk; otherwise just send the content
  let files = [];
  if (story.thumbUrl && story.thumbUrl.startsWith("/static/")) {
    const absThumb = path.join(DATA_ROOT, story.thumbUrl.replace(/^\/static/, ""));
    if (fs.existsSync(absThumb)) files.push(new AttachmentBuilder(absThumb));
  }
  return ch.send({ content, files });
}

// ---------- STABLE STATIC ALIAS (no path-to-regexp wildcards) ----------
// Map /static/<StoryId>/<rest...> to the story folder
app.get(/^\/static\/Stories\/([^/]+)\/(.+)$/, (req, res, next) => {
  const storyId = req.params[0];
  const restRel  = req.params[1];
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

// ---------- LINKS ----------
app.get("/links", (_req, res) => {
  // format: { items: [{ title, url, imageUrl? | imageKey? }] }
  const file = path.join(DATA_ROOT, "app/links.json");
  const val = safeReadJson(file, []);
  const payload = Array.isArray(val) ? { items: val } : val;
  res.json(payload);
});
app.post("/admin/links", requireAdmin, (req, res) => {
  const val = Array.isArray(req.body) ? { items: req.body } : req.body;
  writeJson(path.join(DATA_ROOT, "app/links.json"), val);
  res.json({ ok: true, count: (val.items || []).length });
});

// ---------- SPOTLIGHTS (folder reader) ----------
app.get("/spotlight-videos", (_req, res) => {
  try {
    const root = path.join(DATA_ROOT, "Spotlights");
    if (!fs.existsSync(root)) return res.json([]);
    const list = [];

    for (const name of fs.readdirSync(root)) {
      const dir = path.join(root, name);
      if (!fs.statSync(dir).isDirectory()) continue;

      const titleTxt = path.join(dir, "title.txt");
      const linkTxt  = path.join(dir, "link.txt");

      let title = fs.existsSync(titleTxt) ? fs.readFileSync(titleTxt, "utf8").trim() : name;
      let url   = fs.existsSync(linkTxt)  ? fs.readFileSync(linkTxt,  "utf8").trim() : "";

      const img = (fs.readdirSync(dir).find(f => /^spotlight\b.*\.(png|jpe?g|webp)$/i.test(f)) || null);
      const thumb = img ? `/static/Spotlights/${encodeURIComponent(name)}/${encodeURIComponent(img)}` : null;

      const stat = fs.statSync(dir);
      list.push({ id: name, title, url, thumb, date: stat.mtime.toISOString() });
    }
    // newest first
    list.sort((a,b) => (a.date < b.date ? 1 : -1));
    res.json(list);
  } catch (e) {
    console.error("[spotlight-videos]", e);
    res.json([]);
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

// ---------- STORIES ----------
app.get("/stories", (_req, res) => {
  try { res.json(listStories()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// Playable voicemail redirect for the app
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

    if (typeof req.body.active === "boolean") next.active = req.body.active;

    // If activating, deactivate others
    if (next.active === true) {
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

// ---------- ADMIN: VOICEMAIL (upload) ----------
app.post("/admin/story/:id/voicemail", requireAdmin, upload.single("audio"), async (req, res) => {
  try {
    const storyId = req.params.id;
    if (!req.file) return res.status(400).json({ error: "Missing audio" });

    const dir = storyDirOf(storyId); ensureDir(dir);
    const vmFolder = path.join(dir, "voicemail"); ensureDir(vmFolder);

    // Clean existing mp3s in /voicemail
    try { for (const f of fs.readdirSync(vmFolder)) if (/\.mp3$/i.test(f)) fs.unlinkSync(path.join(vmFolder, f)); } catch {}

    const mp3Name = (req.file.originalname && /\.mp3$/i.test(req.file.originalname)) ? req.file.originalname : "voicemail.mp3";
    const mp3Path = path.join(vmFolder, mp3Name);
    fs.renameSync(req.file.path, mp3Path);

    // Optional: render MP4 (if ffmpeg helper is present)
    if (makeVoicemailVideo) {
      const meta = readStoryMeta(storyId);
      const ytThumbRel = meta.thumbnailYt || meta.youtubeThumbnail || null;
      const ytThumbAbs = ytThumbRel ? path.join(dir, ytThumbRel) : null;
      const mp4Path = path.join(dir, (mp3Name.replace(/\.[^.]+$/, "") || "voicemail") + ".mp4");
      await makeVoicemailVideo(mp3Path, mp4Path, ytThumbAbs && fs.existsSync(ytThumbAbs) ? ytThumbAbs : undefined);
    }

    res.json({ ok: true, mp3: urlFor(mp3Path) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ---------- WITNESS (public + admin) ----------
app.post("/story/:id/witness", upload.single("video"), async (req, res) => {
  try {
    const storyId = req.params.id;
    if (!req.file) return res.status(400).json({ error: "Missing video" });

    const wtDir = path.join(storyDirOf(storyId), "witnesses"); ensureDir(wtDir);
    const outPath = path.join(wtDir, `${Date.now()}.mp4`);
    fs.renameSync(req.file.path, outPath);

    // Post to Discord (breaking-news or voicemail fallback)
    try {
      const channelId = BREAKING_NEWS_CHANNEL_ID || VOICEMAIL_CHANNEL_ID;
      if (channelId) {
        const ch = await discordClient.channels.fetch(channelId);
        if (ch) await ch.send({ content: `🎥 Witness submission — **${storyId}**`, files: [new AttachmentBuilder(outPath)] });
      }
    } catch (e) { console.warn("Discord witness post failed:", e.message); }

    res.json({ ok: true, url: urlFor(outPath) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/admin/story/:id/witness", requireAdmin, upload.single("video"), async (req, res) => {
  try {
    const storyId = req.params.id;
    if (!req.file) return res.status(400).json({ error: "Missing video" });

    const wtDir = path.join(storyDirOf(storyId), "witnesses"); ensureDir(wtDir);
    const outPath = path.join(wtDir, `${Date.now()}.mp4`);
    fs.renameSync(req.file.path, outPath);

    const chId = BREAKING_NEWS_CHANNEL_ID || VOICEMAIL_CHANNEL_ID;
    if (chId) {
      const ch = await discordClient.channels.fetch(chId);
      if (ch) await ch.send({ content: `🎥 Witness submission — **${storyId}**`, files: [new AttachmentBuilder(outPath)] });
    }
    res.json({ ok: true, url: urlFor(outPath) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ---------- ROTATE STORIES ----------
function allStoryIds() {
  const root = path.join(DATA_ROOT, "Stories");
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root).filter(id => fs.existsSync(path.join(root, id, "metadata.json")));
}
const readMeta  = (id) => safeReadJson(path.join(DATA_ROOT, "Stories", id, "metadata.json"), { id });
const writeMeta = (id, meta) => writeJson(path.join(DATA_ROOT, "Stories", id, "metadata.json"), { id, ...meta });

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

// ---------- EXPORT ----------
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
        .filter(Boolean).map(fn => path.join(dir, fn)).filter(p => fs.existsSync(p));
      thumbs.forEach((p, i) => archive.file(p, { name: `${id}/thumb-${i+1}${path.extname(p)}` }));

      const vmAbs = findVoicemailPath(id);
      if (vmAbs) archive.file(vmAbs, { name: `${id}/${path.basename(vmAbs)}` });

      const base = vmAbs ? path.basename(vmAbs).replace(/\.[^.]+$/, "") : "voicemail";
      const vmMp4 = path.join(dir, `${base}.mp4`);
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

// ---------- PUBLISH TO DISCORD ----------
async function publishStories({ all = false } = {}) {
  const stories = listStories();
  const target = all ? stories : stories.filter(s => s.active);
  let posted = 0;

  for (const s of target) {
    try { await postBreakingNewsCard(s); posted++; }
    catch (e) { console.warn("Publish failed for", s.id, e.message); }
  }
  return { stories: stories.length, activePosted: posted };
}

app.post("/admin/publish-stories", requireAdmin, async (_req, res) => {
  try { const r = await publishStories({ all: false }); res.json({ ok: true, ...r }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/admin/publish-stories-all", requireAdmin, async (_req, res) => {
  try { const r = await publishStories({ all: true }); res.json({ ok: true, ...r }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- 404 ----------
app.use((_req, res) => res.status(404).json({ error: "Not found" }));

// ---------- START ----------
const PORT = process.env.PORT || 3030;
app.listen(PORT, () => {
  console.log("[Server] Listening on", PORT);
  console.log("[Server] DATA_ROOT =", DATA_ROOT);
});
