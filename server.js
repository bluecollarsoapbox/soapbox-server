// SOAPBOX SERVER — Render disk + legacy voicemail-folder behavior
// Source of truth on Render disk: /opt/render/project/data
// If Stories/<id>/voicemail/ has a single .mp3, use it. Otherwise:
//   1) metadata.voicemail  2) Stories/<id>/voicemail.mp3

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

const DISCORD_TOKEN            = process.env.DISCORD_TOKEN            || "";
const CONFESSIONS_CHANNEL_ID   = process.env.CONFESSIONS_CHANNEL_ID   || "";
const SPOTLIGHT_CHANNEL_ID     = process.env.SPOTLIGHT_CHANNEL_ID     || "";
const VOICEMAIL_CHANNEL_ID     = process.env.VOICEMAIL_CHANNEL_ID     || ""; // fallback target

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

function readStoryMeta(id) {
  return safeReadJson(path.join(DATA_ROOT, "Stories", id, "metadata.json"), { id });
}

// ---- LEGACY: find voicemail MP3 like it used to ----
function findVoicemailPath(storyId) {
  const dir = storyDirOf(storyId);
  // 1) Folder “voicemail” with one .mp3
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
// Express 5’s path-to-regexp is strict; avoid the old `:rest*` pattern.
// Use a RegExp route to map /static/<id>/<rest> to the story folder:
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
app.get("/links", (_req, res) => res.json(safeReadJson(path.join(DATA_ROOT, "app/links.json"), [])));
app.get("/spotlights", (_req, res) => res.json(safeReadJson(path.join(DATA_ROOT, "app/spotlights.json"), [])));

// ✅ Filesystem-based Spotlight cards (what your app expects)
const IMAGE_EXTS = [".jpg", ".jpeg", ".png", ".webp", ".gif"];
app.get("/spotlight-videos", (_req, res) => {
  try {
    const root = path.join(DATA_ROOT, "Spotlights");
    if (!fs.existsSync(root)) return res.json([]);

    const dirs = fs.readdirSync(root)
      .map(name => ({ name, full: path.join(root, name) }))
      .filter(d => { try { return fs.statSync(d.full).isDirectory(); } catch { return false; } });

    const items = dirs.map(d => {
      const titleFile = path.join(d.full, "title.txt");
      const linkFile  = path.join(d.full, "link.txt");

      // first image in the folder
      let thumbName = null;
      for (const f of fs.readdirSync(d.full)) {
        const ext = path.extname(f).toLowerCase();
        if (IMAGE_EXTS.includes(ext)) { thumbName = f; break; }
      }

      const title = fs.existsSync(titleFile)
        ? fs.readFileSync(titleFile, "utf8").trim()
        : d.name;

      const url = fs.existsSync(linkFile)
        ? fs.readFileSync(linkFile, "utf8").trim()
        : "";

      const thumb = thumbName
        ? `/static/Spotlights/${encodeURIComponent(d.name)}/${encodeURIComponent(thumbName)}`
        : "";

      // sort newest first by folder mtime
      let mtime = 0;
      try { mtime = fs.statSync(d.full).mtimeMs; } catch {}

      return { id: d.name, title, url, thumb, date: mtime ? new Date(mtime).toISOString() : undefined };
    });

    items.sort((a, b) => (b.date ? Date.parse(b.date) : 0) - (a.date ? Date.parse(a.date) : 0));
    res.json(items);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/admin/links", requireAdmin, (req, res) => {
  if (!Array.isArray(req.body)) return res.status(400).json({ error: "Body must be an array of {label,url}" });
  writeJson(path.join(DATA_ROOT, "app/links.json"), req.body);
  res.json({ ok: true, count: req.body.length });
});
app.post("/admin/spotlights", requireAdmin, async (req, res) => {
  if (!Array.isArray(req.body)) return res.status(400).json({ error: "Body must be an array" });
  writeJson(path.join(DATA_ROOT, "app/spotlights.json"), req.body);
  if (SPOTLIGHT_CHANNEL_ID) {
    try { const ch = await discordClient.channels.fetch(SPOTLIGHT_CHANNEL_ID); if (ch) await ch.send("✅ Spotlights updated"); } catch {}
  }
  res.json({ ok: true, count: req.body.length });
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
    }
    res.json(out);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- VOICEMAIL (APP AUTOPLAY) ----------
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
    try {
      for (const f of fs.readdirSync(vmFolder)) if (/\.mp3$/i.test(f)) fs.unlinkSync(path.join(vmFolder, f));
    } catch {}
    const mp3Name = (req.file.originalname && /\.mp3$/i.test(req.file.originalname)) ? req.file.originalname : "voicemail.mp3";
    const mp3Path = path.join(vmFolder, mp3Name);
    fs.renameSync(req.file.path, mp3Path);

    const meta = readStoryMeta(storyId);
    const ytThumbRel = meta.thumbnailYt || meta.youtubeThumbnail || null;
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
    const outPath = path.join(wtDir, `${base}.mp4`);
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

      const vmMp4 = path.join(dir, (path.basename(vmAbs || "voicemail.mp3").replace(/\.[^.]+$/, "") + ".mp4"));
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

    const defaultThumb = path.join(DATA_ROOT, "app", "megaphone.png");
    const mp4Path = path.join(inboxDir, `${base}.mp4`);
    await makeVoicemailVideo(mp3Path, mp4Path, fs.existsSync(defaultThumb) ? defaultThumb : undefined);

    const ch = await discordClient.channels.fetch(VOICEMAIL_CHANNEL_ID);
    if (!ch) return res.status(500).json({ error: "Discord channel not found" });
    await ch.send({ content: "📬 New voicemail", files: [new AttachmentBuilder(mp4Path)] });

    fs.renameSync(mp3Path, path.join(postedDir, `${base}.mp3`));
    fs.renameSync(mp4Path, path.join(postedDir, `${base}.mp4`));

    res.json({ ok: true });
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
