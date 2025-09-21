// server.js — disk-based SOAPBOX server (Render /data)
// Drop-in replacement.

const express = require("express");
const cors = require("cors");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const { Client, GatewayIntentBits } = require("discord.js");

const makeVoicemailVideo = require("./makeVoicemailVideo"); // mp3->mp4 generator
const postToDiscord = require("./discordPoster"); // posts file to proper Discord thread

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

// ----- ROUTES -----

// Health
app.get("/health", (_req, res) =>
  res.json({ ok: true, time: new Date().toISOString() })
);

// Links (GET)
app.get("/links", (req, res) => {
  const file = path.join(DATA_ROOT, "app/links.json");
  res.json(safeReadJson(file, []));
});

// Spotlights (GET)
app.get("/spotlights", (req, res) => {
  const file = path.join(DATA_ROOT, "app/spotlights.json");
  res.json(safeReadJson(file, []));
});

// Confessions (GET + POST)
app.get("/confessions", (req, res) => {
  const file = path.join(DATA_ROOT, "app/confessions.json");
  res.json(safeReadJson(file, []));
});

app.post("/confessions", async (req, res) => {
  const { text } = req.body || {};
  if (!text) return res.status(400).json({ error: "Confession text required" });

  try {
    // save to disk log
    const file = path.join(DATA_ROOT, "app/confessions.json");
    ensureDir(path.dirname(file));
    const arr = safeReadJson(file, []);
    arr.push({ text, at: new Date().toISOString() });
    fs.writeFileSync(file, JSON.stringify(arr, null, 2));

    // post to Discord
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
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ----- ADMIN: LINKS & SPOTLIGHTS (replace-whole-file) -----

app.post("/admin/links", requireAdmin, (req, res) => {
  try {
    if (!Array.isArray(req.body))
      return res
        .status(400)
        .json({ error: "Body must be an array of {label, url}" });
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
    // Optional: post an admin note to Discord
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

// ----- STORIES -----

app.get("/stories", (req, res) => {
  try {
    const root = path.join(DATA_ROOT, "Stories");
    if (!fs.existsSync(root)) return res.json([]);
    const out = [];
    for (const id of fs.readdirSync(root)) {
      const dir = path.join(root, id);
      const metaFile = path.join(dir, "metadata.json");
      if (fs.existsSync(dir) && fs.existsSync(metaFile)) {
        const meta = safeReadJson(metaFile, {});
        out.push({ id, ...meta });
      }
    }
    res.json(out);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ----- ADMIN: VOICEMAIL (mp3 -> mp4 -> Discord) -----

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

      // grab YT thumb path from story metadata if present
      const meta = safeReadJson(path.join(storyDir, "metadata.json"), {});
      const thumb = meta.thumbnailYt
        ? path.join(storyDir, meta.thumbnailYt)
        : null;

      const mp4Path = path.join(vmDir, `${base}.mp4`);
      await makeVoicemailVideo(mp3Path, mp4Path, thumb || undefined);

      // post the mp4 to Discord (thread inferred in your helper)
      await postToDiscord(discordClient, storyId, mp4Path);

      res.json({ ok: true, file: mp4Path });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message });
    }
  }
);

// ----- ADMIN: WITNESS (mp4 -> Discord) -----

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

      res.json({ ok: true, file: outPath });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message });
    }
  }
);

// ----- ADMIN: ROTATE STORIES -----

function storyIds() {
  const root = path.join(DATA_ROOT, "Stories");
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root)
    .filter((id) =>
      fs.existsSync(path.join(root, id, "metadata.json"))
    );
}
function readMeta(id) {
  return safeReadJson(
    path.join(DATA_ROOT, "Stories", id, "metadata.json"),
    { id }
  );
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
