// server.js — disk-based SOAPBOX server (Render /data)
// Drop-in replacement: adds /voicemail/:id + static aliases the app expects.

const express = require("express");
const cors = require("cors");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const { Client, GatewayIntentBits } = require("discord.js");

const makeVoicemailVideo = require("./makeVoicemailVideo"); // mp3->mp4 for Discord inline
const postToDiscord = require("./discordPoster"); // posts files to the right Discord thread

// ----- CONFIG -----
const DATA_ROOT =
  process.env.DATA_DIR ||
  process.env.DATA_ROOT ||
  "/opt/render/project/data";

const ADMIN_KEY = process.env.SOAPBOX_API_KEY || "changeme";
const DISCORD_TOKEN = process.env.DISCORD_TOKEN || "";
const CONFESSIONS_CHANNEL_ID = process.env.CONFESSIONS_CHANNEL_ID || "";
const SPOTLIGHT_CHANNEL_ID = process.env.SPOTLIGHT_CHANNEL_ID || "";

// ----- DISCORD -----
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

// ----- APP -----
const app = express();
app.use(cors());
app.use(express.json({ limit: "25mb" }));

// 🔹 Serve the Render disk so thumbnails/video can stream with range requests
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

// ----- HELPERS -----
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
function requireAdmin(req, res, next) {
  const key = req.header("x-soapbox-key");
  if (ADMIN_KEY && key === ADMIN_KEY) return next();
  return res.status(401).json({ error: "Unauthorized" });
}
function listFiles(dir, exts) {
  try {
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((n) => exts.some((e) => n.toLowerCase().endsWith(e)))
      .map((name) => {
        const p = path.join(dir, name);
        const st = fs.statSync(p);
        return { name, path: p, mtimeMs: st.mtimeMs || 0 };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
  } catch {
    return [];
  }
}

// ----- STATIC ALIASES THE APP EXPECTS -----
// The app asks for /static/:id/metadata.json (not /static/Stories/:id/metadata.json)
app.get("/static/:storyId/metadata.json", (req, res) => {
  const file = path.join(DATA_ROOT, "Stories", req.params.storyId, "metadata.json");
  if (!fs.existsSync(file)) return res.status(404).json({ error: "Not found" });
  res.type("application/json").send(fs.readFileSync(file, "utf8"));
});
// And /static/:id/<anything> → /Stories/:id/<anything>
app.get("/static/:storyId/*", (req, res, next) => {
  const rel = req.params[0] || "";
  const file = path.join(DATA_ROOT, "Stories", req.params.storyId, rel);
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) return next();
  res.sendFile(file);
});

// ----- HEALTH -----
app.get("/health", (_req, res) =>
  res.json({ ok: true, time: new Date().toISOString() })
);

// ----- LINKS / SPOTLIGHTS -----
app.get("/links", (_req, res) => {
  res.json(safeReadJson(path.join(DATA_ROOT, "app/links.json"), []));
});
app.get("/spotlights", (_req, res) => {
  res.json(safeReadJson(path.join(DATA_ROOT, "app/spotlights.json"), []));
});

// ----- CONFESSIONS (GET + POST) -----
app.get("/confessions", (_req, res) => {
  res.json(safeReadJson(path.join(DATA_ROOT, "app/confessions.json"), []));
});
app.post("/confessions", async (req, res) => {
  const { text } = req.body || {};
  if (!text) return res.status(400).json({ error: "Confession text required" });
  try {
    const file = path.join(DATA_ROOT, "app/confessions.json");
    ensureDir(path.dirname(file));
    const arr = safeReadJson(file, []);
    arr.push({ text, at: new Date().toISOString() });
    fs.writeFileSync(file, JSON.stringify(arr, null, 2));

    if (CONFESSIONS_CHANNEL_ID) {
      try {
        const ch = await discordClient.channels.fetch(CONFESSIONS_CHANNEL_ID);
        if (ch) await ch.send(text);
      } catch (e) {
        console.warn("[Discord] Confession post failed:", e.message);
      }
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ----- ADMIN: LINKS & SPOTLIGHTS (replace files) -----
app.post("/admin/links", requireAdmin, (req, res) => {
  try {
    if (!Array.isArray(req.body))
      return res.status(400).json({ error: "Body must be an array of {label, url}" });
    const file = path.join(DATA_ROOT, "app/links.json");
    ensureDir(path.dirname(file));
    fs.writeFileSync(file, JSON.stringify(req.body, null, 2));
    res.json({ ok: true, count: req.body.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
app.post("/admin/spotlights", requireAdmin, (req, res) => {
  try {
    if (!Array.isArray(req.body))
      return res.status(400).json({ error: "Body must be an array" });
    const file = path.join(DATA_ROOT, "app/spotlights.json");
    ensureDir(path.dirname(file));
    fs.writeFileSync(file, JSON.stringify(req.body, null, 2));
    if (SPOTLIGHT_CHANNEL_ID) {
      discordClient.channels
        .fetch(SPOTLIGHT_CHANNEL_ID)
        .then((ch) => ch && ch.send("✅ Spotlights updated"))
        .catch(() => {});
    }
    res.json({ ok: true, count: req.body.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ----- STORIES (list) -----
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
        // expose thumbnail URLs for the list view
        const thumbRel =
          meta.thumbnailYt || meta.youtubeThumbnail || meta.thumbnail || null;
        const thumbUrl = thumbRel ? `/static/Stories/${id}/${thumbRel}` : null;
        out.push({ id, title: meta.title || id, subtitle: meta.subtitle || "", thumbUrl });
      }
    }
    res.json(out);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ----- VOICEMAIL (the route your app autoplays) -----
// Returns a redirect to the newest .mp3 under /Stories/:id/voicemails
app.get("/voicemail/:id", (req, res) => {
  const id = String(req.params.id || "");
  const dir = path.join(DATA_ROOT, "Stories", id, "voicemails");
  const mp3s = listFiles(dir, [".mp3"]);
  const choice = mp3s[0];
  if (!choice) return res.status(404).json({ error: "No voicemail for this story" });
  const rel = choice.path.replace(DATA_ROOT, "").replace(/\\/g, "/");
  res.redirect(302, `/static${rel}`); // lets the client stream/seek
});

// ----- ADMIN: VOICEMAIL UPLOAD (mp3 -> mp4 for Discord) -----
app.post(
  "/admin/story/:id/voicemail",
  requireAdmin,
  upload.single("audio"),
  async (req, res) => {
    try {
      const storyId = req.params.id;
      if (!req.file) return res.status(400).json({ error: "Missing audio" });

      const storyDir = path.join(DATA_ROOT, "Stories", storyId);
      const vmDir = path.join(storyDir, "voicemails");
      ensureDir(vmDir);

      const base = Date.now().toString();
      const mp3Path = path.join(vmDir, `${base}.mp3`);
      fs.renameSync(req.file.path, mp3Path);

      const meta = safeReadJson(path.join(storyDir, "metadata.json"), {});
      const thumb = meta.thumbnailYt
        ? path.join(storyDir, meta.thumbnailYt)
        : null;

      const mp4Path = path.join(vmDir, `${base}.mp4`);
      await makeVoicemailVideo(mp3Path, mp4Path, thumb || undefined);

      // Post the mp4 to Discord (thread inferred in your helper)
      await postToDiscord(discordClient, storyId, mp4Path);

      // Return the public URLs so the app could use them if needed
      const mp3Rel = mp3Path.replace(DATA_ROOT, "").replace(/\\/g, "/");
      const mp4Rel = mp4Path.replace(DATA_ROOT, "").replace(/\\/g, "/");
      res.json({ ok: true, mp3: `/static${mp3Rel}`, mp4: `/static${mp4Rel}` });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message });
    }
  }
);

// ----- ADMIN: WITNESS UPLOAD (mp4 -> Discord) -----
app.post(
  "/admin/story/:id/witness",
  requireAdmin,
  upload.single("video"),
  async (req, res) => {
    try {
      const storyId = req.params.id;
      if (!req.file) return res.status(400).json({ error: "Missing video" });

      const storyDir = path.join(DATA_ROOT, "Stories", storyId);
      const wtDir = path.join(storyDir, "witnesses");
      ensureDir(wtDir);

      const outPath = path.join(wtDir, `${Date.now()}.mp4`);
      fs.renameSync(req.file.path, outPath);

      await postToDiscord(discordClient, storyId, outPath);

      const rel = outPath.replace(DATA_ROOT, "").replace(/\\/g, "/");
      res.json({ ok: true, url: `/static${rel}` });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message });
    }
  }
);

// ----- ROTATE STORIES -----
function storyIds() {
  const root = path.join(DATA_ROOT, "Stories");
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root)
    .filter((id) => fs.existsSync(path.join(root, id, "metadata.json")));
}
function readMeta(id) {
  return safeReadJson(path.join(DATA_ROOT, "Stories", id, "metadata.json"), { id });
}
function writeMeta(id, meta) {
  const file = path.join(DATA_ROOT, "Stories", id, "metadata.json");
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify({ id, ...meta }, null, 2));
}
function setActive(targetId) {
  const ids = storyIds();
  if (!ids.includes(targetId)) throw new Error(`Story '${targetId}' not found`);
  let activeMeta = null;
  ids.forEach((id) => {
    const meta = readMeta(id);
    meta.active = id === targetId;
    writeMeta(id, meta);
    if (meta.active) activeMeta = meta;
  });
  return { activeId: targetId, meta: activeMeta, ids };
}
app.post("/admin/rotate-story/:id", requireAdmin, (req, res) => {
  try {
    const result = setActive(req.params.id);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
app.post("/admin/rotate-stories", requireAdmin, (req, res) => {
  try {
    const ids = storyIds();
    if (ids.length === 0) return res.status(400).json({ error: "No stories" });
    const currentIndex = ids.findIndex((id) => readMeta(id).active);
    const next = currentIndex >= 0 ? (currentIndex + 1) % ids.length : 0;
    const result = setActive(ids[next]);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ----- 404 -----
app.use((_req, res) => res.status(404).json({ error: "Not found" }));

// ----- START -----
const PORT = process.env.PORT || 3030;
app.listen(PORT, () => {
  console.log("[Server] Listening on", PORT);
  console.log("[Server] DATA_ROOT =", DATA_ROOT);
});
