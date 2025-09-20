// server.js
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { Client, GatewayIntentBits } = require("discord.js");
const makeVoicemailVideo = require("./makeVoicemailVideo");
const postToDiscord = require("./discordPoster");

// --- CONFIG ---
const DATA_ROOT = process.env.DATA_DIR || process.env.DATA_ROOT || "/opt/render/project/data";
const ADMIN_KEY = process.env.SOAPBOX_API_KEY || "changeme";
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CONFESSIONS_CHANNEL_ID = process.env.CONFESSIONS_CHANNEL_ID;
const SPOTLIGHT_CHANNEL_ID = process.env.SPOTLIGHT_CHANNEL_ID;

// --- DISCORD CLIENT ---
const discordClient = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });
if (DISCORD_TOKEN) {
  discordClient.login(DISCORD_TOKEN)
    .then(() => console.log("[Discord] Logged in"))
    .catch(err => console.error("[Discord] Login failed", err));
}

// --- APP INIT ---
const app = express();
app.use(cors());
app.use(express.json());
const upload = multer({ dest: path.join(DATA_ROOT, "tmp") });

// --- HELPERS ---
function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}
function requireAdmin(req, res, next) {
  const key = req.header("x-soapbox-key");
  if (key === ADMIN_KEY) return next();
  return res.status(401).json({ error: "Unauthorized" });
}

// --- ROUTES ---

// Health
app.get("/health", (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// Links
app.get("/links", (req, res) => {
  try {
    const file = path.join(DATA_ROOT, "app/links.json");
    if (!fs.existsSync(file)) return res.json([]);
    res.json(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Spotlights (GET)
app.get("/spotlights", (req, res) => {
  try {
    const file = path.join(DATA_ROOT, "app/spotlights.json");
    if (!fs.existsSync(file)) return res.json([]);
    res.json(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Confessions (GET + POST)
app.get("/confessions", (req, res) => {
  try {
    const file = path.join(DATA_ROOT, "app/confessions.json");
    if (!fs.existsSync(file)) return res.json([]);
    res.json(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/confessions", async (req, res) => {
  const { text } = req.body || {};
  if (!text) return res.status(400).json({ error: "Confession text required" });

// --- ADMIN: LINKS & SPOTLIGHTS (REPLACE-WHOLE-FILE) ---

// Replace the entire links.json with the body you send (must be an array)
app.post("/admin/links", requireAdmin, (req, res) => {
  try {
    const file = path.join(DATA_ROOT, "app/links.json");
    if (!Array.isArray(req.body)) {
      return res.status(400).json({ error: "Body must be an array of {label, url}" });
    }
    ensureDir(path.dirname(file));
    fs.writeFileSync(file, JSON.stringify(req.body, null, 2));
    res.json({ ok: true, count: req.body.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Replace the entire spotlights.json with the body you send (must be an array)
app.post("/admin/spotlights", requireAdmin, (req, res) => {
  try {
    const file = path.join(DATA_ROOT, "app/spotlights.json");
    if (!Array.isArray(req.body)) {
      return res.status(400).json({ error: "Body must be an array of items" });
    }
    ensureDir(path.dirname(file));
    fs.writeFileSync(file, JSON.stringify(req.body, null, 2));
    res.json({ ok: true, count: req.body.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


  try {
    // Save to disk
    const file = path.join(DATA_ROOT, "app/confessions.json");
    let arr = [];
    if (fs.existsSync(file)) arr = JSON.parse(fs.readFileSync(file, "utf8"));
    arr.push({ text, at: new Date().toISOString() });
    ensureDir(path.dirname(file));
    fs.writeFileSync(file, JSON.stringify(arr, null, 2));

    // Post to Discord
    if (CONFESSIONS_CHANNEL_ID) {
      const chan = await discordClient.channels.fetch(CONFESSIONS_CHANNEL_ID);
      await chan.send(text);
    }

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Stories
app.get("/stories", (req, res) => {
  try {
    const storiesDir = path.join(DATA_ROOT, "Stories");
    if (!fs.existsSync(storiesDir)) return res.json([]);

    const out = [];
    for (const storyId of fs.readdirSync(storiesDir)) {
      const metaFile = path.join(storiesDir, storyId, "metadata.json");
      if (fs.existsSync(metaFile)) {
        const meta = JSON.parse(fs.readFileSync(metaFile, "utf8"));
        out.push({ id: storyId, ...meta });
      }
    }
    res.json(out);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin: upload voicemail
app.post("/admin/story/:id/voicemail", requireAdmin, upload.single("audio"), async (req, res) => {
  try {
    const storyId = req.params.id;
    const storyDir = path.join(DATA_ROOT, "Stories", storyId, "voicemails");
    ensureDir(storyDir);

    const inFile = req.file.path;
    const base = Date.now().toString();
    const mp3File = path.join(storyDir, `${base}.mp3`);
    fs.renameSync(inFile, mp3File);

    // Convert to MP4
    const metaFile = path.join(DATA_ROOT, "Stories", storyId, "metadata.json");
    const meta = fs.existsSync(metaFile) ? JSON.parse(fs.readFileSync(metaFile, "utf8")) : {};
    const thumb = meta.youtubeThumbnail ? path.join(DATA_ROOT, "Stories", storyId, meta.youtubeThumbnail) : null;

    const mp4File = path.join(storyDir, `${base}.mp4`);
    await makeVoicemailVideo(mp3File, mp4File, thumb);

    // Post to Discord thread
    await postToDiscord(discordClient, storyId, mp4File);

    res.json({ ok: true, file: mp4File });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Admin: upload witness
app.post("/admin/story/:id/witness", requireAdmin, upload.single("video"), async (req, res) => {
  try {
    const storyId = req.params.id;
    const storyDir = path.join(DATA_ROOT, "Stories", storyId, "witnesses");
    ensureDir(storyDir);

    const inFile = req.file.path;
    const outFile = path.join(storyDir, `${Date.now()}.mp4`);
    fs.renameSync(inFile, outFile);

    // Post to Discord thread
    await postToDiscord(discordClient, storyId, outFile);

    res.json({ ok: true, file: outFile });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Fallback
app.use((req, res) => {
  res.status(404).json({ error: "Not found" });
});

// Start
const PORT = process.env.PORT || 3030;
app.listen(PORT, () => console.log(`[Server] Running on ${PORT}`));
