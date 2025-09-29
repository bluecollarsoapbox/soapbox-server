// SOAPBOX SERVER — Render disk + legacy voicemail-folder behavior + Discord Forum posting
// Source of truth on Render disk: /opt/render/project/data
// Voicemail pick order per story:
//   1) first .mp3 inside Stories/<id>/voicemail/
//   2) metadata.voicemail (relative to Stories/<id>/)
//   3) Stories/<id>/voicemail.mp3

const express = require("express");
const cors = require("cors");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const archiver = require("archiver");
const { Client, GatewayIntentBits, AttachmentBuilder } = require("discord.js");

let externalPoster = null;
try { externalPoster = require("./discordPoster"); } catch (_) {}

const makeVoicemailVideo = require("./makeVoicemailVideo");

// ---------- CONFIG ----------
const DATA_ROOT = process.env.DATA_DIR || process.env.DATA_ROOT || "/opt/render/project/data";
const ADMIN_KEY  = process.env.SOAPBOX_API_KEY || "changeme";

const DISCORD_TOKEN              = process.env.DISCORD_TOKEN              || "";
const CONFESSIONS_CHANNEL_ID     = process.env.CONFESSIONS_CHANNEL_ID     || "";
const SPOTLIGHT_CHANNEL_ID       = process.env.SPOTLIGHT_CHANNEL_ID       || "";
const VOICEMAIL_CHANNEL_ID       = process.env.VOICEMAIL_CHANNEL_ID       || ""; // generic fallback
const BREAKING_NEWS_CHANNEL_ID   = process.env.BREAKING_NEWS_CHANNEL_ID   || ""; // Forum channel for story posts

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

// Serve the entire Render disk as /static
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

function readStoryMeta(id) { return safeReadJson(path.join(DATA_ROOT, "Stories", id, "metadata.json"), { id }); }

// Legacy voicemail resolver
function findVoicemailPath(storyId) {
  const dir = storyDirOf(storyId);

  // 1) Folder “voicemail” with at least one .mp3
  const vmFolder = path.join(dir, "voicemail");
  if (fs.existsSync(vmFolder) && fs.statSync(vmFolder).isDirectory()) {
    const mp3s = (fs.readdirSync(vmFolder) || []).filter(f => /\.mp3$/i.test(f));
    if (mp3s.length >= 1) return path.join(vmFolder, mp3s[0]); // first mp3
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

async function postFileToDiscord(storyId, absFilePath, content = "") {
  // Prefer your existing poster (keeps thread routing, formatting)
  if (externalPoster && typeof externalPoster === "function") {
    try { return await externalPoster(discordClient, storyId, absFilePath, content); }
    catch (e) { console.warn("[DiscordPoster] external poster failed, falling back:", e.message); }
  }
  if (!VOICEMAIL_CHANNEL_ID) throw new Error("No VOICEMAIL_CHANNEL_ID set and external poster unavailable.");
  const ch = await discordClient.channels.fetch(VOICEMAIL_CHANNEL_ID);
  if (!ch) throw new Error("Discord channel not found");
  const file = new AttachmentBuilder(absFilePath);
  return ch.send({ content, files: [file] });
}

// ---------- STATIC ALIASES THE APP EXPECTS ----------
// Express 5 route parser is strict; use a RegExp instead of :rest*
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

// ---------- LINKS (server-managed) ----------
app.get("/links", (_req, res) => {
  // Return { items: [...] } to match the app
  const arr = safeReadJson(path.join(DATA_ROOT, "app/links.json"), []);
  res.json({ items: Array.isArray(arr) ? arr : [] });
});
app.post("/admin/links", requireAdmin, (req, res) => {
  let list = [];
  if (Array.isArray(req.body)) list = req.body;
  else if (req.body && Array.isArray(req.body.items)) list = req.body.items;
  else return res.status(400).json({ error: "Body must be an array or {items: array}" });

  writeJson(path.join(DATA_ROOT, "app/links.json"), list);
  res.json({ ok: true, count: list.length });
});

// ---------- SPOTLIGHTS (form goes to Discord) ----------
app.post("/spotlights", async (req, res) => {
  try {
    const { name = "", link = "", notes = "" } = req.body || {};
    if (!name || !link) return res.status(400).json({ error: "Missing name or link" });
    if (!SPOTLIGHT_CHANNEL_ID) return res.status(500).json({ error: "SPOTLIGHT_CHANNEL_ID not set" });

    const ch = await discordClient.channels.fetch(SPOTLIGHT_CHANNEL_ID);
    if (!ch) return res.status(500).json({ error: "Spotlight channel not found" });

    const content =
      `📝 **Spotlight Submission**\n` +
      `**Name:** ${name}\n` +
      `**Link:** ${link}\n` +
      (notes ? `**Notes:** ${notes}\n` : "");

    await ch.send({ content });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
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
        const thumbUrl = thumbRel ? `/static/Stories/${id}/${thumbRel}` : null;

        const vmAbs = findVoicemailPath(id);
        const voicemailUrl = vmAbs ? urlFor(vmAbs) : null;

        out.push({
          id,
          title: meta.title || meta.headline || id,
          subtitle: meta.subtitle || meta.subcaption || "",
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

// ---------- VOICEMAIL (APP AUTOPLAY REDIRECT) ----------
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
    if (typeof req.body.voicemail === "string") next.voicemail = req.body.voicemail; // optional override

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

// ---------- ADMIN: VOICEMAIL (per story) ----------
app.post("/admin/story/:id/voicemail", requireAdmin, upload.single("audio"), async (req, res) => {
  try {
    const storyId = req.params.id;
    if (!req.file) return res.status(400).json({ error: "Missing audio" });

    const dir = storyDirOf(storyId); ensureDir(dir);
    // Put new mp3 in the voicemail folder (legacy style)
    const vmFolder = path.join(dir, "voicemail"); ensureDir(vmFolder);
    // Clean out old mp3s in that folder
    try { for (const f of fs.readdirSync(vmFolder)) if (/\.mp3$/i.test(f)) fs.unlinkSync(path.join(vmFolder, f)); } catch {}
    const mp3Name = (req.file.originalname && /\.mp3$/i.test(req.file.originalname)) ? req.file.originalname : "voicemail.mp3";
    const mp3Path = path.join(vmFolder, mp3Name);
    fs.renameSync(req.file.path, mp3Path);

    const meta = readStoryMeta(storyId);
    const ytThumbRel = meta.thumbnailYt || meta.youtubeThumbnail || meta.thumbnail || null;
    const ytThumbAbs = ytThumbRel ? path.join(dir, ytThumbRel) : null;

    const mp4Path = path.join(dir, (mp3Name.replace(/\.[^.]+$/, "") || "voicemail") + ".mp4");
    await makeVoicemailVideo(mp3Path, mp4Path, ytThumbAbs && fs.existsSync(ytThumbAbs) ? ytThumbAbs : undefined);

    await postFileToDiscord(storyId, mp4Path, `📣 Voicemail for **${storyId}**`);

    res.json({ ok: true, mp3: urlFor(mp3Path), mp4: urlFor(mp4Path) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ---------- ADMIN: WITNESS (per story) ----------
app.post("/admin/story/:id/witness", requireAdmin, upload.single("video"), async (req, res) => {
  try {
    const storyId = req.params.id;
    if (!req.file) return res.status(400).json({ error: "Missing video" });

    const wtDir = path.join(storyDirOf(storyId), "witnesses"); ensureDir(wtDir);
    const base = Date.now().toString();
    let outPath = path.join(wtDir, `${base}.mp4`);
    // if user gave a .mov/.webm/etc. we still store as .mp4 filename
    fs.renameSync(req.file.path, outPath);

    await postFileToDiscord(storyId, outPath, `🎥 Witness submission — **${storyId}**`);
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

// ---------- PUBLISH to DISCORD FORUM (Breaking News) ----------
// POST /admin/publish-stories   body: { channelId?: string, all?: boolean }
// - If all=true => publish all stories with metadata.json
// - Else => publish only active=true stories
// First message in each new thread = "**Headline**\nSubtitle" + attached MP4 (inline playable)
async function publishOneStoryToForum(forumId, storyId) {
  const forum = await discordClient.channels.fetch(forumId);
  if (!forum) throw new Error("Forum channel not found");

  const meta = readStoryMeta(storyId);
  const dir = storyDirOf(storyId);

  const title = meta.title || meta.headline || storyId;
  const subtitle = meta.subtitle || meta.subcaption || "";
  const content = subtitle ? `**${title}**\n${subtitle}` : `**${title}**`;

  // Build/attach video so Discord shows inline player
  const mp3Abs = findVoicemailPath(storyId);
  const thumbRel = meta.thumbnailYt || meta.youtubeThumbnail || meta.thumbnail || null;
  const thumbAbs = thumbRel ? path.join(dir, thumbRel) : null;

  const files = [];
  if (mp3Abs) {
    const mp4Abs = path.join(dir, (path.basename(mp3Abs, path.extname(mp3Abs)) || "voicemail") + ".mp4");
    if (!fs.existsSync(mp4Abs)) {
      await makeVoicemailVideo(
        mp3Abs,
        mp4Abs,
        thumbAbs && fs.existsSync(thumbAbs) ? thumbAbs : undefined
      );
    }
    if (fs.existsSync(mp4Abs)) files.push(new AttachmentBuilder(mp4Abs).setName(path.basename(mp4Abs)));
  }
  if (!files.length && thumbAbs && fs.existsSync(thumbAbs)) {
    files.push(new AttachmentBuilder(thumbAbs).setName(path.basename(thumbAbs)));
  }

  // create a new forum thread with first message
  const created = await forum.createForumThread({
    name: title,
    message: { content, files },
  });

  return { threadId: created?.thread?.id || created?.id || null, title };
}

app.post("/admin/publish-stories", requireAdmin, async (req, res) => {
  try {
    const forumId = (req.body && req.body.channelId) || BREAKING_NEWS_CHANNEL_ID;
    if (!forumId) return res.status(400).json({ error: "Breaking News forum channel id not set" });

    const ids = allStoryIds().filter(id => fs.existsSync(path.join(storyDirOf(id), "metadata.json")));
    if (!ids.length) return res.status(400).json({ error: "No stories found" });

    const publishAll = !!(req.body && req.body.all);
    const toPost = publishAll ? ids : ids.filter(id => !!readMeta(id).active);

    const results = [];
    for (const id of toPost) {
      try {
        const r = await publishOneStoryToForum(forumId, id);
        results.push({ id, ok: true, threadId: r.threadId });
      } catch (e) {
        console.error("[publish]", id, e);
        results.push({ id, ok: false, error: String(e && e.message || e) });
      }
    }

    res.json({ ok: true, count: results.length, results });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// Back-compat alias people kept trying
app.post("/admin/publish-stories-all", requireAdmin, async (req, res) => {
  req.body = { ...(req.body || {}), all: true };
  return app._router.handle(req, res, () => {}, "post", "/admin/publish-stories");
});

// ---------- EXPORT (ZIP) ----------
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

      if (vmAbs) {
        const mp4 = path.join(dir, (path.basename(vmAbs, path.extname(vmAbs)) + ".mp4"));
        if (fs.existsSync(mp4)) archive.file(mp4, { name: `${id}/${path.basename(mp4)}` });
      }

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

// ---------- 404 ----------
app.use((_req, res) => res.status(404).json({ error: "Not found" }));

// ---------- START ----------
const PORT = process.env.PORT || 3030;
app.listen(PORT, () => {
  console.log("[Server] Listening on", PORT);
  console.log("[Server] DATA_ROOT =", DATA_ROOT);
});
