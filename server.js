// SOAPBOX SERVER — Render disk + legacy voicemail-folder behavior
// Source of truth on Render disk: /opt/render/project/data (or DATA_ROOT)
// If Stories/<id>/voicemail/ has a single .mp3, use it. Otherwise:
//   1) metadata.voicemail  2) Stories/<id>/voicemail.mp3

const express = require("express");
const cors = require("cors");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const archiver = require("archiver");
const { Client, GatewayIntentBits, AttachmentBuilder, ChannelType } = require("discord.js");

// ---------- CONFIG ----------
const DATA_ROOT = process.env.DATA_DIR || process.env.DATA_ROOT || "/opt/render/project/data";
const ADMIN_KEY  = process.env.SOAPBOX_API_KEY || "changeme";

// Discord envs (can be overridden per-request)
const DISCORD_TOKEN              = process.env.DISCORD_TOKEN || "";
const BREAKING_NEWS_CHANNEL_ID   = process.env.BREAKING_NEWS_CHANNEL_ID || ""; // Forum channel
const CONFESSIONS_CHANNEL_ID     = process.env.CONFESSIONS_CHANNEL_ID || "";
const SPOTLIGHT_CHANNEL_ID       = process.env.SPOTLIGHT_CHANNEL_ID || "";
const VOICEMAIL_CHANNEL_ID       = process.env.VOICEMAIL_CHANNEL_ID || ""; // fallback target

// optional external poster (keep compatibility if you had one)
let externalPoster = null;
try { externalPoster = require("./discordPoster"); } catch (_) {}

// ffmpeg video maker (lazy-loaded so startup never crashes)
let makeVoicemailVideoModule = null;
async function ensureVoicemailVideo(mp3Abs, mp4Abs, thumbAbs) {
  if (!makeVoicemailVideoModule) {
    try {
      makeVoicemailVideoModule = require("./makeVoicemailVideo"); // your existing helper
    } catch (e) {
      console.warn("[FFmpeg] unavailable:", e.message || e);
      return null;
    }
  }
  try {
    await makeVoicemailVideoModule(mp3Abs, mp4Abs, thumbAbs);
    return mp4Abs;
  } catch (e) {
    console.warn("[FFmpeg] failed:", e.message || e);
    return null;
  }
}

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
function spotlightsRoot() { return path.join(DATA_ROOT, "Spotlights"); }

function fileUrlFrom(absPath) {
  // turns abs path into /static/<encoded path>
  const rel = absPath.replace(DATA_ROOT, "").replace(/^[\\/]/, "");
  return "/static/" + rel.split(path.sep).map(encodeURIComponent).join("/");
}

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

function getBestThumbAbsForStory(id, meta) {
  const candidates = [meta.thumbnailYt, meta.youtubeThumbnail, meta.thumbnail].filter(Boolean);
  for (const name of candidates) {
    const abs = path.join(storyDirOf(id), name);
    if (fs.existsSync(abs)) return abs;
  }
  // also check common names if metadata not set
  for (const fn of ["thumbnail-yt.png","thumbnail-yt.jpg","thumbnail.png","thumbnail.jpg"]) {
    const abs = path.join(storyDirOf(id), fn);
    if (fs.existsSync(abs)) return abs;
  }
  return null;
}

function allStoryIds() {
  const root = path.join(DATA_ROOT, "Stories");
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root)
    .filter(id => fs.existsSync(path.join(root, id, "metadata.json")));
}

// store thread mapping so witness/voicemail can post into the right thread
const THREADS_FILE = path.join(DATA_ROOT, "discord", "threads.json");
function readThreads() { return safeReadJson(THREADS_FILE, {}); }
function saveThreads(map) { writeJson(THREADS_FILE, map); }

// robust channel fetch
async function fetchChannelFlexible(channelId) {
  try {
    const ch = await discordClient.channels.fetch(channelId);
    return ch || null;
  } catch { return null; }
}

// forum/text poster that returns threadId if applicable
async function postToChannelOrForum({ channelId, headline, subtitle, files }) {
  const ch = await fetchChannelFlexible(channelId);
  if (!ch) throw new Error("Discord channel not found");

  const content = `**${headline.trim()}**\n${subtitle ? subtitle.trim() : ""}`.trim();

  // If it's a forum channel, create a post (thread) with the first message carrying the attachments
  if (ch.type === ChannelType.GuildForum) {
    const thread = await ch.threads.create({
      name: headline.slice(0, 90),
      message: { content, files }
    });
    return { type: "forum", threadId: thread.id };
  }

  // If it's a regular text channel, just send the message (attachments render inline)
  if (typeof ch.send === "function") {
    await ch.send({ content, files });
    return { type: "text" };
  }

  // As a last resort try a VOICEMAIL fallback text channel
  if (VOICEMAIL_CHANNEL_ID) {
    const fb = await fetchChannelFlexible(VOICEMAIL_CHANNEL_ID);
    if (fb && typeof fb.send === "function") {
      await fb.send({ content, files });
      return { type: "text-fallback" };
    }
  }

  throw new Error("Unsupported channel type");
}

// ---------- STATIC ALIASES THE APP EXPECTS ----------
app.get(/^\/static\/([^/]+)\/(.+)$/, (req, res, next) => {
  const first = req.params[0];
  const restRel = req.params[1];
  // allow /static/Stories/<id>/... OR /static/Spotlights/<name>/...
  const topDir = decodeURIComponent(first);
  const full = path.join(DATA_ROOT, topDir, restRel.split("/").map(decodeURIComponent).join(path.sep));
  if (!fs.existsSync(full) || fs.statSync(full).isDirectory()) return next();
  res.sendFile(full);
});

app.get("/static/:storyId/metadata.json", (req, res) => {
  const file = path.join(storyDirOf(req.params.storyId), "metadata.json");
  if (!fs.existsSync(file)) return res.status(404).json({ error: "Not found" });
  res.type("application/json").send(fs.readFileSync(file, "utf8"));
});

// ---------- HEALTH ----------
app.get("/health", (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// ---------- LINKS / SPOTLIGHTS JSON (optional admin) ----------
app.get("/links", (_req, res) => res.json(safeReadJson(path.join(DATA_ROOT, "app/links.json"), { items: [] })));
app.get("/spotlights", (_req, res) => res.json(safeReadJson(path.join(DATA_ROOT, "app/spotlights.json"), [])));

app.post("/admin/links", requireAdmin, (req, res) => {
  if (!req.body || typeof req.body !== "object") return res.status(400).json({ error: "Body must be an object like {items:[...]}" });
  writeJson(path.join(DATA_ROOT, "app/links.json"), req.body);
  res.json({ ok: true, count: Array.isArray(req.body.items) ? req.body.items.length : 0 });
});
app.post("/admin/spotlights", requireAdmin, async (req, res) => {
  if (!Array.isArray(req.body)) return res.status(400).json({ error: "Body must be an array" });
  writeJson(path.join(DATA_ROOT, "app/spotlights.json"), req.body);
  if (SPOTLIGHT_CHANNEL_ID) {
    try { const ch = await discordClient.channels.fetch(SPOTLIGHT_CHANNEL_ID); if (ch && typeof ch.send === "function") await ch.send("✅ Spotlights updated"); } catch {}
  }
  res.json({ ok: true, count: req.body.length });
});

// ---------- CONFESSIONS ----------
app.post("/confessions", async (req, res) => {
  const { text } = req.body || {};
  if (!text) return res.status(400).json({ error: "Confession text required" });
  if (CONFESSIONS_CHANNEL_ID) {
    try {
      const ch = await fetchChannelFlexible(CONFESSIONS_CHANNEL_ID);
      if (ch && typeof ch.send === "function") await ch.send(text);
    } catch (e) { console.warn("[Confessions] post failed:", e.message || e); }
  }
  res.json({ ok: true });
});

// ---------- SPOTLIGHT FEED (auto from folders on disk) ----------
app.get("/spotlight-videos", (_req, res) => {
  const root = spotlightsRoot();
  const out = [];
  try {
    if (!fs.existsSync(root)) return res.json(out);
    for (const name of fs.readdirSync(root)) {
      const dir = path.join(root, name);
      if (!fs.statSync(dir).isDirectory()) continue;
      const titleTxt = path.join(dir, "title.txt");
      const linkTxt  = path.join(dir, "link.txt");
      const images = (fs.readdirSync(dir).filter(f => /\.(png|jpe?g)$/i.test(f)) || []);
      if (!fs.existsSync(titleTxt) || !fs.existsSync(linkTxt) || !images.length) continue;
      const title = fs.readFileSync(titleTxt, "utf8").trim();
      const url   = fs.readFileSync(linkTxt, "utf8").trim();
      const thumbAbs = path.join(dir, images[0]);
      out.push({
        id: name,
        title,
        url,
        thumb: fileUrlFrom(thumbAbs),
        date: new Date(fs.statSync(thumbAbs).mtimeMs).toISOString()
      });
    }
    out.sort((a,b) => (a.date < b.date ? 1 : -1));
    res.json(out);
  } catch (e) {
    console.error("[spotlight-videos]", e);
    res.json(out);
  }
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
      if (!fs.existsSync(dir) || !fs.existsSync(metaFile)) continue;

      const meta = safeReadJson(metaFile, {});
      const thumbAbs = getBestThumbAbsForStory(id, meta);
      const vmAbs = findVoicemailPath(id);

      out.push({
        id,
        headline: meta.title || id,
        title: meta.title || id, // keep both to satisfy any client code
        subtitle: meta.subtitle || "",
        active: !!meta.active,
        prompts: Array.isArray(meta.prompts) ? meta.prompts : [],
        thumbUrl: thumbAbs ? fileUrlFrom(thumbAbs) : null,
        voicemailUrl: vmAbs ? fileUrlFrom(vmAbs) : null
      });
    }
    res.json(out);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- VOICEMAIL (APP AUDIO) ----------
app.get("/voicemail/:id", (req, res) => {
  const vmAbs = findVoicemailPath(req.params.id);
  if (!vmAbs) return res.status(404).json({ error: "No voicemail for this story" });
  res.redirect(302, fileUrlFrom(vmAbs));
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

    res.json({ ok: true, thumbnail: fileUrlFrom(dest) });
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

    res.json({ ok: true, thumbnailYt: fileUrlFrom(dest) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- ADMIN: VOICEMAIL UPLOAD -> MAKE MP4 -> POST TO THREAD ----------
app.post("/admin/story/:id/voicemail", requireAdmin, upload.single("audio"), async (req, res) => {
  try {
    const storyId = req.params.id;
    if (!req.file) return res.status(400).json({ error: "Missing audio" });

    const dir = storyDirOf(storyId); ensureDir(dir);
    const vmFolder = path.join(dir, "voicemail"); ensureDir(vmFolder);

    // clean prior mp3s
    try { for (const f of fs.readdirSync(vmFolder)) if (/\.mp3$/i.test(f)) fs.unlinkSync(path.join(vmFolder, f)); } catch {}

    const mp3Name = (req.file.originalname && /\.mp3$/i.test(req.file.originalname)) ? req.file.originalname : "voicemail.mp3";
    const mp3Path = path.join(vmFolder, mp3Name);
    fs.renameSync(req.file.path, mp3Path);

    const meta = readStoryMeta(storyId);
    const thumbAbs = getBestThumbAbsForStory(storyId, meta);
    const mp4Path = path.join(dir, (mp3Name.replace(/\.[^.]+$/, "") || "voicemail") + ".mp4");

    const made = await ensureVoicemailVideo(mp3Path, mp4Path, thumbAbs);
    const files = made && fs.existsSync(made)
      ? [new AttachmentBuilder(made)]
      : [new AttachmentBuilder(mp3Path)];

    // post into existing thread if we have one
    const map = readThreads();
    const threadId = map[storyId];
    if (threadId) {
      try {
        const thread = await discordClient.channels.fetch(threadId);
        if (thread && typeof thread.send === "function") {
          await thread.send({ files });
        }
      } catch (e) {
        console.warn("[voicemail->thread] failed, falling back to Breaking News:", e.message || e);
      }
    }

    // also post to fallback voicemail channel if set and thread missing
    if (!threadId && VOICEMAIL_CHANNEL_ID) {
      try {
        const ch = await fetchChannelFlexible(VOICEMAIL_CHANNEL_ID);
        if (ch && typeof ch.send === "function") await ch.send({ content: `📣 Voicemail for **${storyId}**`, files });
      } catch {}
    }

    res.json({ ok: true, mp3: fileUrlFrom(mp3Path), mp4: fs.existsSync(mp4Path) ? fileUrlFrom(mp4Path) : null });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ---------- ADMIN: WITNESS (per story) -> post into thread ----------
app.post("/admin/story/:id/witness", requireAdmin, upload.single("video"), async (req, res) => {
  try {
    const storyId = req.params.id;
    if (!req.file) return res.status(400).json({ error: "Missing video" });

    const wtDir = path.join(storyDirOf(storyId), "witnesses"); ensureDir(wtDir);
    const base = Date.now().toString();
    const outPath = path.join(wtDir, `${base}.mp4`);
    fs.renameSync(req.file.path, outPath);

    const map = readThreads();
    const threadId = map[storyId];
    if (threadId) {
      try {
        const thread = await discordClient.channels.fetch(threadId);
        if (thread && typeof thread.send === "function") {
          await thread.send({ content: "🎥 Witness submission", files: [new AttachmentBuilder(outPath)] });
        }
      } catch (e) {
        console.warn("[witness->thread] failed:", e.message || e);
      }
    }
    res.json({ ok: true, url: fileUrlFrom(outPath) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ---------- ADMIN: PUBLISH TO DISCORD (ALL STORIES) ----------
app.post("/admin/publish-stories-all", express.json(), async (req, res) => {
  try {
    const key = req.headers["x-soapbox-key"];
    if (key !== ADMIN_KEY) return res.status(401).json({ error: "Unauthorized" });

    // channel preference: body -> header -> query -> env
    const channelId = String(
      (req.body && req.body.channelId) ||
      req.headers["x-soapbox-channel-id"] ||
      (req.query ? req.query.channelId : "") ||
      BREAKING_NEWS_CHANNEL_ID ||
      ""
    ).trim();
    if (!channelId) return res.status(400).json({ error: "No channelId provided and BREAKING_NEWS_CHANNEL_ID not set" });

    const ids = allStoryIds();
    if (!ids.length) return res.status(400).json({ error: "No stories" });

    const map = readThreads();
    let posted = 0;

    for (const id of ids) {
      const meta = readStoryMeta(id);
      const headline = (meta.title || id).trim();
      const subtitle = (meta.subtitle || "").trim();

      const thumbAbs = getBestThumbAbsForStory(id, meta);
      const mp3Abs = findVoicemailPath(id);
      const dir = storyDirOf(id);
      const mp4Abs = path.join(dir, (mp3Abs ? path.basename(mp3Abs).replace(/\.[^.]+$/, "") : "voicemail") + ".mp4");

      let files = [];
      if (mp3Abs) {
        if (!fs.existsSync(mp4Abs)) await ensureVoicemailVideo(mp3Abs, mp4Abs, thumbAbs);
        if (fs.existsSync(mp4Abs)) {
          files.push(new AttachmentBuilder(mp4Abs));
        } else {
          // if no mp4, at least include thumb or mp3 so there's something to click
          if (thumbAbs && fs.existsSync(thumbAbs)) files.push(new AttachmentBuilder(thumbAbs));
          files.push(new AttachmentBuilder(mp3Abs));
        }
      } else if (thumbAbs && fs.existsSync(thumbAbs)) {
        files.push(new AttachmentBuilder(thumbAbs));
      }

      // If we already have a thread recorded, just post the main card again (keeps thread together)
      let threadId = map[id];
      if (threadId) {
        try {
          const thread = await discordClient.channels.fetch(threadId);
          if (thread && typeof thread.send === "function") {
            await thread.send({ content: `**${headline}**\n${subtitle}`, files });
            posted++;
            continue;
          }
        } catch (_) { /* will re-create below */ }
      }

      // Create new forum post / or text post
      const result = await postToChannelOrForum({ channelId, headline, subtitle, files });
      if (result.type === "forum" && result.threadId) {
        map[id] = result.threadId;
        saveThreads(map);
      }
      posted++;
    }

    res.json({ ok: true, stories: ids.length, posted, threadsTracked: Object.keys(map).length });
  } catch (err) {
    console.error("[publish-stories-all]", err);
    res.status(500).json({ error: err.message });
  }
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

      const vmMp4 = path.join(dir, ((vmAbs ? path.basename(vmAbs) : "voicemail.mp3").replace(/\.[^.]+$/, "")) + ".mp4");
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
    await ensureVoicemailVideo(mp3Path, mp4Path, fs.existsSync(defaultThumb) ? defaultThumb : undefined);

    const ch = await fetchChannelFlexible(VOICEMAIL_CHANNEL_ID);
    if (!ch) return res.status(500).json({ error: "Discord channel not found" });
    await ch.send({ content: "📬 New voicemail", files: [new AttachmentBuilder(fs.existsSync(mp4Path) ? mp4Path : mp3Path)] });

    fs.renameSync(mp3Path, path.join(postedDir, `${base}.mp3`));
    if (fs.existsSync(mp4Path)) fs.renameSync(mp4Path, path.join(postedDir, `${base}.mp4`));

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});
// --- FIX: static aliases (place near your other /static handlers) ---

// Old form I added earlier (keep it):
app.get(/^\/static\/([^/]+)\/(.+)$/, (req, res, next) => {
  const storyId = req.params[0];
  const restRel = req.params[1];
  const file = path.join(storyDirOf(storyId), restRel);
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) return next();
  res.sendFile(file);
});

// NEW: support your real URLs: /static/Stories/:id/:rest
app.get(/^\/static\/Stories\/([^/]+)\/(.+)$/, (req, res, next) => {
  const storyId = req.params[0];
  const restRel = req.params[1];
  const file = path.join(storyDirOf(storyId), restRel);
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) return next();
  res.sendFile(file);
});

// ---------- 404 ----------
app.use((_req, res) => res.status(404).json({ error: "Not found" }));

// ---------- START ----------
const PORT = process.env.PORT || 3030;
app.listen(PORT, () => {
  console.log("[Server] Listening on", PORT);
  console.log("[Server] DATA_ROOT =", DATA_ROOT);
});
