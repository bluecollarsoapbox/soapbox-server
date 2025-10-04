// SOAPBOX SERVER — forum-safe, legacy voicemail folder, big embed + MP3, stable routes

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

let makeVoicemailVideo = null; // optional; if present, used only for admin upload
try { makeVoicemailVideo = require("./makeVoicemailVideo"); } catch (_) {}

// ---------- CONFIG ----------
const DATA_ROOT = process.env.DATA_DIR || process.env.DATA_ROOT || "/opt/render/project/data";
const ADMIN_KEY = process.env.SOAPBOX_API_KEY || "changeme";

// --- VIDEO RULES ---
const REQUIRE_LANDSCAPE = true; // set true to HARD-REJECT portrait uploads
const TARGET_W = 1280, TARGET_H = 720; // letterbox target (16:9)


// Discord envs (BREAKING_NEWS has a safe fallback to your known ID)
const DISCORD_TOKEN            = process.env.DISCORD_TOKEN || "";
const CONFESSIONS_CHANNEL_ID   = process.env.CONFESSIONS_CHANNEL_ID || "";
const SPOTLIGHT_CHANNEL_ID     = process.env.SPOTLIGHT_CHANNEL_ID || "";
const VOICEMAIL_CHANNEL_ID     = process.envVOICEMAIL_CHANNEL_ID || process.env.VOICEMAIL_CHANNEL_ID || "";
const BREAKING_NEWS_CHANNEL_ID = process.env.BREAKING_NEWS_CHANNEL_ID || "1407176815285637313"; // forum channel

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
function readStoryMeta(id) { return safeReadJson(path.join(DATA_ROOT, "Stories", id, "metadata.json"), { id }); }

// ---- thread map helpers ----
function readThreadMap() {
  return safeReadJson(path.join(DATA_ROOT, "app", "threads.json"), {}); // { StoryId: "discordThreadId" }
}
function writeThreadMap(map) {
  writeJson(path.join(DATA_ROOT, "app", "threads.json"), map || {});
}

// ---- LEGACY: find voicemail MP3 like it used to ----
function findVoicemailPath(storyId) {
  const dir = storyDirOf(storyId);

  // 1) Folder “voicemail” with .mp3; take the first alpha
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
  res.json(safeReadJson(path.join(DATA_ROOT, "app", "links.json"), { items: [] }));
});

// Filesystem-driven spotlights:
function listSpotlightsFS() {
  const root = path.join(DATA_ROOT, "Spotlights");
  if (!fs.existsSync(root)) return [];

  const entries = fs.readdirSync(root, { withFileTypes: true })
    .filter(d => d.isDirectory());

  const pickImage = (dirAbs) => {
    const files = fs.readdirSync(dirAbs);
    const img = files.find(f => /\.(png|jpe?g|webp)$/i.test(f));
    return img ? img : null;
  };

  const items = entries.map(ent => {
    const id = ent.name;
    const dirAbs = path.join(root, id);

    const titleTxt = path.join(dirAbs, "title.txt");
    const linkTxt  = path.join(dirAbs, "link.txt");

    const title = fs.existsSync(titleTxt)
      ? fs.readFileSync(titleTxt, "utf8").toString().trim()
      : id;

    const url = fs.existsSync(linkTxt)
      ? fs.readFileSync(linkTxt, "utf8").toString().trim()
      : "";

    const img = pickImage(dirAbs);
    const thumb = img
      ? `/static/Spotlights/${encodeURIComponent(id)}/${encodeURIComponent(img)}`
      : "";

    const statForSort =
      img && fs.existsSync(path.join(dirAbs, img))
        ? fs.statSync(path.join(dirAbs, img)).mtimeMs
        : fs.statSync(dirAbs).mtimeMs;

    return { id, title, url, thumb, _sort: statForSort };
  })
  .filter(x => x.title && x.url)
  .sort((a, b) => b._sort - a._sort)
  .map(({ _sort, ...rest }) => rest);

  return items;
}

app.get("/spotlights", (_req, res) => {
  try {
    const list = listSpotlightsFS();
    return res.json(list);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: String(e.message || e) });
  }
});

app.post("/admin/links", requireAdmin, (req, res) => {
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

        const thumbRelNonYt = meta.thumbnail || null; // for grid/list
        const thumbRelYt    = meta.thumbnailYt || meta.youtubeThumbnail || null; // for detail

        const thumbUrl   = thumbRelNonYt ? `/static/Stories/${id}/${thumbRelNonYt}` : null;
        const thumbYtUrl = thumbRelYt    ? `/static/Stories/${id}/${thumbRelYt}`    : null;

        const vmAbs = findVoicemailPath(id);
        const voicemailUrl = vmAbs ? urlFor(vmAbs) : null;

        out.push({
          id,
          title: meta.title || id,
          subtitle: meta.subtitle || "",
          active: !!meta.active,
          prompts: Array.isArray(meta.prompts) ? meta.prompts : [],
          thumbUrl,
          thumbYtUrl,
          voicemailUrl
        });
      }
    }
    res.json(out);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- VOICEMAIL (APP REDIRECT) ----------
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

// ---------- ffprobe (dims) ----------
async function getVideoDims(filePath) {
  try {
    const ffmpeg = require("fluent-ffmpeg");
    return new Promise((resolve) => {
      ffmpeg.ffprobe(filePath, (err, data) => {
        if (err) return resolve(null);
        const vs = (data.streams || []).find(s => s.codec_type === "video");
        if (!vs) return resolve(null);
        const w = Number(vs.width || 0), h = Number(vs.height || 0);
        resolve({ width: w, height: h });
      });
    });
  } catch (_) {
    return null;
  }
}

// ---------- GLOBAL maybeWatermark (letterbox 16:9 + optional watermark) ----------
async function maybeWatermark(inputPath, outputPath) {
  let ffmpeg, ffmpegPath;
  try { ffmpeg = require("fluent-ffmpeg"); } catch (_) { return null; }

  // Resolve ffmpeg binary
  try {
    const staticPath = require("ffmpeg-static");
    if (staticPath && fs.existsSync(staticPath)) ffmpegPath = staticPath;
  } catch(_) {}
  if (!ffmpegPath) {
    try {
      const inst = require("@ffmpeg-installer/ffmpeg");
      if (inst && inst.path && fs.existsSync(inst.path)) ffmpegPath = inst.path;
    } catch(_) {}
  }
  if (!ffmpegPath) return null;

  ffmpeg.setFfmpegPath(ffmpegPath);

 // Optional watermark image (check several common spots)
const candidateWMs = [
  path.join(DATA_ROOT, "app", "watermark.png"),
  path.join(DATA_ROOT, "app", "wm.png"),
  // your repo/local paths:
  path.join(__dirname, "assets", "logo.png"),
  path.join(process.cwd(), "assets", "logo.png"),
  path.join(__dirname, "assets", "watermark.png"),
  path.join(process.cwd(), "assets", "watermark.png"),
];

let wm = null;
for (const p of candidateWMs) {
  if (fs.existsSync(p)) { wm = p; break; }
}
  ensureDir(path.dirname(outputPath));

  // scale to fit, pad to 1280x720, keep SAR=1, then overlay watermark if present
  const baseScalePad =
    `scale=${TARGET_W}:${TARGET_H}:force_original_aspect_ratio=decrease,` +
    `pad=${TARGET_W}:${TARGET_H}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1`;

  return new Promise((resolve, reject) => {
    const cmd = ffmpeg(inputPath)
      .outputOptions([
        "-movflags +faststart",
        "-c:v libx264",
        "-preset veryfast",
        "-crf 23",
        "-c:a aac",
        "-b:a 160k"
      ]);

    if (wm) {
      cmd.input(wm)
         .complexFilter([
           `[0:v]${baseScalePad}[v0]`,
           `[v0][1:v]overlay=10:10[vout]`
         ])
         .outputOptions(["-map", "[vout]", "-map", "0:a?"]);
    } else {
      cmd.videoFilters(baseScalePad);
    }

    cmd.on("error", (e) => { try { fs.unlinkSync(outputPath); } catch(_) {} reject(e); })
       .on("end", () => resolve(outputPath))
       .save(outputPath);
  }).catch(() => null);
}

// ---------- ADMIN: VOICEMAIL UPLOAD (per story) ----------
app.post("/admin/story/:id/voicemail", requireAdmin, upload.single("audio"), async (req, res) => {
  try {
    const storyId = req.params.id;
    if (!req.file) return res.status(400).json({ error: "Missing audio" });

    const dir = storyDirOf(storyId); ensureDir(dir);
    const vmFolder = path.join(dir, "voicemail"); ensureDir(vmFolder);

    try {
      for (const f of fs.readdirSync(vmFolder)) if (/\.mp3$/i.test(f)) fs.unlinkSync(path.join(vmFolder, f));
    } catch {}

    const mp3Name = (req.file.originalname && /\.mp3$/i.test(req.file.originalname)) ? req.file.originalname : "voicemail.mp3";
    const mp3Path = path.join(vmFolder, mp3Name);
    fs.renameSync(req.file.path, mp3Path);

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

// ---------- THREAD UTILS (NEW) ----------
async function getOrCreateThread(channelId, storyId, headline, contentIfCreate) {
  const ch = await discordClient.channels.fetch(channelId);
  if (!ch) throw new Error("Breaking News channel not found");

  let map = readThreadMap();
  let threadId = map[storyId];

  // 1) Try mapped thread ID first
  if (threadId) {
    try {
      const existing = await discordClient.channels.fetch(threadId);
      if (existing) return existing;
    } catch (_) { /* fall through */ }
  }

  // 2) Try to find an existing thread by name (active + archived)
  if (ch.type === ChannelType.GuildForum) {
    const nameCandidates = new Set([
      headline.toLowerCase(),
      storyId.toLowerCase(),
    ]);

    try {
      const active = await ch.threads.fetchActive();
      const foundA = active?.threads?.find(t => nameCandidates.has(String(t.name || "").toLowerCase()));
      if (foundA) {
        map[storyId] = foundA.id; writeThreadMap(map);
        return foundA;
      }
    } catch (_) {}

    try {
      const archived = await ch.threads.fetchArchived();
      const foundB = archived?.threads?.find(t => nameCandidates.has(String(t.name || "").toLowerCase()));
      if (foundB) {
        map[storyId] = foundB.id; writeThreadMap(map);
        return foundB;
      }
    } catch (_) {}
  }

  // 3) Create a new thread and save mapping
  if (ch.type === ChannelType.GuildForum) {
    const created = await ch.threads.create({
      name: headline,
      message: contentIfCreate ? { content: contentIfCreate } : undefined,
    });
    map[storyId] = created.id; writeThreadMap(map);
    return created;
  }

  // Non-forum fallback: just use the channel
  return ch;
}

// ---------- DISCORD PUBLISH HELPERS ----------
function resolveStoryAssets(storyId) {
  const dir = storyDirOf(storyId);
  const meta = readStoryMeta(storyId);
  const title = (meta.title || storyId).toString();
  const sub = (meta.subtitle || "").toString();

  const thumbRel = meta.thumbnailYt || meta.youtubeThumbnail || meta.thumbnail || null;
  const thumbFile = thumbRel ? path.join(dir, thumbRel) : null;

  const vmMp3 = findVoicemailPath(storyId);
  const mediaFile = (vmMp3 && fs.existsSync(vmMp3)) ? vmMp3 : null;

  return {
    title,
    sub,
    thumbFile: (thumbFile && fs.existsSync(thumbFile)) ? thumbFile : null,
    mediaFile
  };
}

async function publishStoryOnce(storyId, channelIdOverride) {
  if (externalPoster && typeof externalPoster === "function") {
    try { return await externalPoster(discordClient, storyId); }
    catch (e) { console.warn("[DiscordPoster] external poster failed:", e.message || e); }
  }

  const { title, sub, thumbFile, mediaFile } = resolveStoryAssets(storyId);

  const headline = title?.trim() || storyId;
  const subline = sub?.trim() || "";

  const embeds = [{
    title: headline,
    description: subline || undefined,
    image: thumbFile ? { url: "attachment://thumb" + path.extname(thumbFile).toLowerCase() } : undefined,
  }];

  const files = [];
  if (thumbFile) files.push(new AttachmentBuilder(thumbFile, { name: "thumb" + path.extname(thumbFile).toLowerCase() }));
  if (mediaFile) files.push(new AttachmentBuilder(mediaFile, { name: "voicemail.mp3" }));

  const targetChannelId = channelIdOverride || BREAKING_NEWS_CHANNEL_ID || VOICEMAIL_CHANNEL_ID;
  if (!targetChannelId) throw new Error("BREAKING_NEWS_CHANNEL_ID not set and no override provided");

  const thread = await getOrCreateThread(targetChannelId, storyId, headline, subline ? `**${headline}**\n${subline}` : `**${headline}**`);
  if (thread.type === ChannelType.GuildForum || thread.isThread?.()) {
    return await thread.send({ embeds, files });
  }
  return await thread.send({ embeds, files });
}

// ---------- PUBLISH ALL ----------
function allStoryIds() {
  const root = path.join(DATA_ROOT, "Stories");
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root).filter(id => fs.existsSync(path.join(root, id, "metadata.json")));
}
function readMeta(id) { return safeReadJson(path.join(DATA_ROOT, "Stories", id, "metadata.json"), { id }); }
function writeMeta(id, meta) { writeJson(path.join(DATA_ROOT, "Stories", id, "metadata.json"), { id, ...meta }); }

async function publishActiveStories(channelIdOverride) {
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
async function publishAllStories(channelIdOverride) {
  const ids = allStoryIds();
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
    const results = await publishAllStories(override);
    res.json({ ok: true, results });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || String(e) });
  }
});

app.post("/admin/publish-stories", requireAdmin, async (req, res) => {
  try {
    const override = (req.body && req.body.channelId) ? String(req.body.channelId) : "";
    const results = await publishActiveStories(override);
    res.json({ ok: true, results });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || String(e) });
  }
});

// ---------- ADMIN: WITNESS (posts into story's thread) ----------
app.post("/admin/story/:id/witness", requireAdmin, upload.single("video"), async (req, res) => {
  try {
    const storyId = req.params.id;
    if (!req.file) return res.status(400).json({ error: "Missing video" });

    // Save originals and posted copies
    const wtRoot       = path.join(storyDirOf(storyId), "witnesses");
    const originalsDir = path.join(wtRoot, "originals");
    const postedDir    = path.join(wtRoot, "posted");
    ensureDir(originalsDir);
    ensureDir(postedDir);

    const ts           = Date.now();
    const ext          = path.extname(req.file.originalname || "").toLowerCase() || ".mp4";
    const originalPath = path.join(originalsDir, `${ts}${ext}`);
    fs.renameSync(req.file.path, originalPath);

    // HARD reject portrait if configured
    if (REQUIRE_LANDSCAPE) {
      const dims = await getVideoDims(originalPath);
      if (dims && dims.width && dims.height && dims.height > dims.width) {
        try { fs.unlinkSync(originalPath); } catch(_) {}
        return res.status(400).json({ error: "Please upload landscape (wide) video. Portrait is not accepted." });
      }
    }

    // Try watermark/normalize; else send original
    const watermarkedPath = path.join(postedDir, `${ts}.mp4`);
    let toSend = await maybeWatermark(originalPath, watermarkedPath);
    if (!toSend) toSend = originalPath;

    // Post into the mapped thread if present, else Voicemails channel
    const map = readThreadMap();
    const mappedThread = map[storyId];

    if (mappedThread) {
      const thread = await discordClient.channels.fetch(mappedThread);
      if (thread) {
        await thread.send({
          content: `🎥 Witness submission — **${storyId}**`,
          files: [new AttachmentBuilder(toSend)]
        });
      } else {
        if (!VOICEMAIL_CHANNEL_ID) return res.status(500).json({ error: "VOICEMAIL_CHANNEL_ID not set" });
        const ch = await discordClient.channels.fetch(VOICEMAIL_CHANNEL_ID);
        if (!ch) return res.status(500).json({ error: "Discord channel not found" });
        await ch.send({ content: `🎥 Witness submission — **${storyId}**`, files: [new AttachmentBuilder(toSend)] });
      }
    } else {
      if (!VOICEMAIL_CHANNEL_ID) return res.status(500).json({ error: "VOICEMAIL_CHANNEL_ID not set" });
      const ch = await discordClient.channels.fetch(VOICEMAIL_CHANNEL_ID);
      if (!ch) return res.status(500).json({ error: "Discord channel not found" });
      await ch.send({ content: `🎥 Witness submission — **${storyId}**`, files: [new AttachmentBuilder(toSend)] });
    }

    res.json({
      ok: true,
      original: urlFor(originalPath),
      posted: toSend === originalPath ? null : urlFor(watermarkedPath)
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ---------- DEBUG ----------
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

// ---------- ROTATE STORIES ----------
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
        .filter(Boolean)
        .map(fn => path.join(dir, fn))
        .filter(p => fs.existsSync(p));
      thumbs.forEach((p, i) => archive.file(p, { name: `${id}/thumb-${i+1}${path.extname(p)}` }));

      const vmAbs = findVoicemailPath(id);
      if (vmAbs) archive.file(vmAbs, { name: `${id}/${path.basename(vmAbs)}` });

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

// ---------- VOICEMAIL INBOX → Voicemails channel ----------
app.post("/admin/discord/voicemail", requireAdmin, upload.single("audio"), async (req, res) => {
  try {
    if (!VOICEMAIL_CHANNEL_ID) return res.status(400).json({ error: "VOICEMAIL_CHANNEL_ID not set" });
    if (!req.file) return res.status(400).json({ error: "Missing audio" });

    const inboxDir = path.join(DATA_ROOT, "inbox", "discord-voicemails"); ensureDir(inboxDir);
    const postedDir = path.join(DATA_ROOT, "posted", "discord-voicemails"); ensureDir(postedDir);

    const base = Date.now().toString();
    const mp3Path = path.join(inboxDir, `${base}.mp3`);
    fs.renameSync(req.file.path, mp3Path);

    const ch = await discordClient.channels.fetch(VOICEMAIL_CHANNEL_ID);
    if (!ch) return res.status(500).json({ error: "Discord channel not found" });

    const files = [new AttachmentBuilder(mp3Path)];
    await ch.send({ content: "📬 New voicemail", files });

    fs.renameSync(mp3Path, path.join(postedDir, `${base}.mp3`));
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ---- WITNESS INDEX (for local sync; admin-protected)
app.get("/admin/witness-index", requireAdmin, (_req, res) => {
  try {
    const storiesRoot = path.join(DATA_ROOT, "Stories");
    if (!fs.existsSync(storiesRoot)) {
      return res.json({ ok: true, stories: [] });
    }

    const result = [];

    for (const storyId of fs.readdirSync(storiesRoot)) {
      const witDir = path.join(storiesRoot, storyId, "witnesses", "originals");
      if (!fs.existsSync(witDir)) continue;

      const files = fs.readdirSync(witDir)
        .filter(f => /\.(mp4|mov|mkv|avi)$/i.test(f))
        .map(f => ({
          file: f,
          url: `/static/Stories/${encodeURIComponent(storyId)}/witnesses/originals/${encodeURIComponent(f)}`
        }));

      if (files.length) {
        result.push({ storyId, files });
      }
    }

    res.json({ ok: true, stories: result });
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
