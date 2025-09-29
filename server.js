// SOAPBOX SERVER — Render disk + legacy voicemail-folder behavior
// Source of truth on Render disk: /opt/render/project/data

const express = require("express");
const cors = require("cors");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const archiver = require("archiver");
const { Client, GatewayIntentBits, AttachmentBuilder, ChannelType } = require("discord.js");

// ---------- CONFIG ----------
const DATA_ROOT = process.env.DATA_DIR || process.env.DATA_ROOT || "/opt/render/project/data";
const ADMIN_KEY = process.env.SOAPBOX_API_KEY || "changeme";

// Discord
const DISCORD_TOKEN = process.env.DISCORD_TOKEN || "";
const BREAKING_NEWS_CHANNEL_ID = process.env.BREAKING_NEWS_CHANNEL_ID || ""; // forum channel
const CONFESSIONS_CHANNEL_ID = process.env.CONFESSIONS_CHANNEL_ID || "";
const SPOTLIGHT_CHANNEL_ID = process.env.SPOTLIGHT_CHANNEL_ID || "";
const VOICEMAIL_CHANNEL_ID = process.env.VOICEMAIL_CHANNEL_ID || ""; // generic inbox fallback

// public base for absolute URLs (used for Discord embed images)
// if not set, we’ll derive from the incoming request host when needed
const PUBLIC_BASE = process.env.PUBLIC_BASE || "";

// ---------- DISCORD ----------
const discordClient = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
});
if (DISCORD_TOKEN) {
  discordClient
    .login(DISCORD_TOKEN)
    .then(() => console.log("[Discord] Logged in"))
    .catch((err) => console.error("[Discord] Login failed:", err));
} else {
  console.warn("[Discord] No DISCORD_TOKEN set");
}

// ---------- APP ----------
const app = express();
app.use(cors());
app.use(express.json({ limit: "25mb" }));

// Serve the entire Render disk as /static
app.use(
  "/static",
  express.static(DATA_ROOT, {
    fallthrough: true,
    setHeaders(res) {
      res.setHeader("Access-Control-Allow-Origin", "*");
    },
  })
);

const upload = multer({ dest: path.join(DATA_ROOT, "tmp") });

// ---------- HELPERS ----------
function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}
function safeReadJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}
function writeJson(file, obj) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
}
function requireAdmin(req, res, next) {
  const key = req.header("x-soapbox-key");
  if (ADMIN_KEY && key === ADMIN_KEY) return next();
  return res.status(401).json({ error: "Unauthorized" });
}
function storyDirOf(id) {
  return path.join(DATA_ROOT, "Stories", id);
}
function urlFor(absPath, req) {
  // absolute for Discord, relative ok for app
  const rel = "/static" + absPath.replace(DATA_ROOT, "").replace(/\\/g, "/");
  const base =
    PUBLIC_BASE ||
    (req && req.headers && req.headers.host ? `https://${req.headers.host}` : "");
  return base ? base + rel : rel;
}
function readStoryMeta(id) {
  return safeReadJson(path.join(DATA_ROOT, "Stories", id, "metadata.json"), { id });
}

// ---- LEGACY: find voicemail MP3 like it used to ----
function findVoicemailPath(storyId) {
  const dir = storyDirOf(storyId);

  // 1) Folder “voicemail” with one .mp3 (use first .mp3)
  const vmFolder = path.join(dir, "voicemail");
  if (fs.existsSync(vmFolder) && fs.statSync(vmFolder).isDirectory()) {
    const mp3s = (fs.readdirSync(vmFolder) || []).filter((f) => /\.mp3$/i.test(f));
    if (mp3s.length >= 1) return path.join(vmFolder, mp3s[0]);
  }

  // 2) metadata.voicemail (relative to story dir)
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

function allStoryIds() {
  const root = path.join(DATA_ROOT, "Stories");
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root)
    .filter((id) => fs.existsSync(path.join(root, id, "metadata.json")));
}

function loadStories(req) {
  const out = [];
  for (const id of allStoryIds()) {
    const dir = storyDirOf(id);
    const meta = safeReadJson(path.join(dir, "metadata.json"), {});
    const headline = meta.title || meta.headline || id;
    const subtitle = meta.subtitle || "";
    const thumbRel = meta.thumbnailYt || meta.youtubeThumbnail || meta.thumbnail || null;
    const thumbAbs = thumbRel ? path.join(dir, thumbRel) : null;
    const thumbUrl = thumbAbs && fs.existsSync(thumbAbs) ? urlFor(thumbAbs, req) : null;

    const vmAbs = findVoicemailPath(id);
    const vmMp4Abs = path.join(dir, ((vmAbs && path.basename(vmAbs)) || "voicemail.mp3").replace(/\.[^.]+$/, "") + ".mp4");

    out.push({
      id,
      headline,
      subtitle,
      active: !!meta.active,
      thumbUrl,
      voicemailMp3Abs: vmAbs && fs.existsSync(vmAbs) ? vmAbs : null,
      voicemailMp4Abs: fs.existsSync(vmMp4Abs) ? vmMp4Abs : null,
    });
  }
  return out;
}

// ---------- STATIC ALIAS THE APP EXPECTS (Express 5 safe) ----------
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

// ---------- LINKS / SPOTLIGHTS (simple JSON files under data/app) ----------
app.get("/links", (_req, res) => res.json(safeReadJson(path.join(DATA_ROOT, "app/links.json"), [])));
app.get("/spotlights", (_req, res) => res.json(safeReadJson(path.join(DATA_ROOT, "app/spotlights.json"), [])));

app.post("/admin/links", requireAdmin, (req, res) => {
  if (!Array.isArray(req.body)) return res.status(400).json({ error: "Body must be an array of {label,url}" });
  writeJson(path.join(DATA_ROOT, "app/links.json"), req.body);
  res.json({ ok: true, count: req.body.length });
});

app.post("/admin/spotlights", requireAdmin, async (req, res) => {
  if (!Array.isArray(req.body)) return res.status(400).json({ error: "Body must be an array" });
  writeJson(path.join(DATA_ROOT, "app/spotlights.json"), req.body);
  try {
    if (SPOTLIGHT_CHANNEL_ID) {
      const ch = await discordClient.channels.fetch(SPOTLIGHT_CHANNEL_ID);
      if (ch && ch.send) await ch.send("✅ Spotlights updated");
    }
  } catch {}
  res.json({ ok: true, count: req.body.length });
});

// ---------- CONFESSIONS ----------
app.get("/confessions", (_req, res) => res.json(safeReadJson(path.join(DATA_ROOT, "app/confessions.json"), [])));

app.post("/confessions", async (req, res) => {
  const { text } = req.body || {};
  if (!text) return res.status(400).json({ error: "Confession text required" });

  const file = path.join(DATA_ROOT, "app/confessions.json");
  const arr = safeReadJson(file, []);
  arr.push({ text, at: new Date().toISOString() });
  writeJson(file, arr);

  if (CONFESSIONS_CHANNEL_ID) {
    try {
      const ch = await discordClient.channels.fetch(CONFESSIONS_CHANNEL_ID);
      if (ch && ch.send) await ch.send(text);
    } catch {}
  }
  res.json({ ok: true });
});

// ---------- STORIES (LIST for the app) ----------
app.get("/stories", (req, res) => {
  try {
    const list = loadStories(req).map((s) => ({
      id: s.id,
      headline: s.headline,
      subtitle: s.subtitle,
      active: s.active,
      thumbUrl: s.thumbUrl,
      voicemailUrl: s.voicemailMp3Abs ? urlFor(s.voicemailMp3Abs, req) : null,
    }));
    res.json(list);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- VOICEMAIL (APP) ----------
app.get("/voicemail/:id", (req, res) => {
  const vmAbs = findVoicemailPath(req.params.id);
  if (!vmAbs) return res.status(404).json({ error: "No voicemail for this story" });
  res.redirect(302, urlFor(vmAbs, req));
});

// ---------- ADMIN: BULK PUBLISH TO BREAKING NEWS (FORUM SAFE) ----------
app.post("/admin/publish-stories-all", express.json(), async (req, res) => {
  try {
    const key = req.headers["x-soapbox-key"];
    if (key !== ADMIN_KEY) return res.status(401).json({ error: "Unauthorized" });

    const channelId = (req.body && req.body.channelId) || BREAKING_NEWS_CHANNEL_ID;
    if (!channelId) {
      return res.status(400).json({ error: "No channelId provided and BREAKING_NEWS_CHANNEL_ID not set" });
    }

    const channel = await discordClient.channels.fetch(channelId);
    if (!channel) return res.status(404).json({ error: "Channel not found" });

    const stories = loadStories(req);

    let published = 0;
    for (const s of stories) {
      // Build embed (headline + subtitle + image)
      const embed = {
        title: s.headline || s.id,
        description: s.subtitle || "",
        color: 0xff3146,
        image: s.thumbUrl ? { url: s.thumbUrl } : undefined,
      };

      // Prefer mp4, else mp3. Either will play inline in the thread.
      const fileAbs = s.voicemailMp4Abs && fs.existsSync(s.voicemailMp4Abs)
        ? s.voicemailMp4Abs
        : s.voicemailMp3Abs && fs.existsSync(s.voicemailMp3Abs)
          ? s.voicemailMp3Abs
          : null;

      const files = fileAbs ? [new AttachmentBuilder(fileAbs)] : [];

      if (channel.type === ChannelType.GuildForum) {
        await channel.threads.create({
          name: s.headline || s.id,
          message: files.length ? { embeds: [embed], files } : { embeds: [embed] },
        });
      } else {
        await channel.send(files.length ? { embeds: [embed], files } : { embeds: [embed] });
      }

      published++;
    }

    res.json({ ok: true, published });
  } catch (err) {
    console.error("publish-stories-all failed:", err);
    res.status(500).json({ error: "Internal Server Error", detail: String(err && err.message || err) });
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
