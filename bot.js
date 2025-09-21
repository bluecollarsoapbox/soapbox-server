// bot.js — Discord bot that reads /data and announces active story changes
// No S3. Uses Render disk at /opt/render/project/data (or DATA_DIR/DATA_ROOT)

const fs = require("fs");
const path = require("path");
const { Client, GatewayIntentBits, AttachmentBuilder } = require("discord.js");

// ----- CONFIG -----
const DATA_ROOT =
  process.env.DATA_DIR ||
  process.env.DATA_ROOT ||
  "/opt/render/project/data";

const DISCORD_TOKEN = process.env.DISCORD_TOKEN || "";
const BREAKING_CHANNEL_ID = process.env.BREAKING_CHANNEL_ID || "";          // text channel to announce active story
const DISCORD_FORUM_CHANNEL_ID = process.env.DISCORD_FORUM_CHANNEL_ID || ""; // optional fallback

// ----- DISCORD CLIENT -----
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
});

function log(...a) { console.log("[Bot]", ...a); }
function warn(...a) { console.warn("[Bot]", ...a); }

function storyRoot() {
  return path.join(DATA_ROOT, "Stories");
}

function listStoryIds() {
  const root = storyRoot();
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root).filter((id) => {
    const dir = path.join(root, id);
    return fs.existsSync(path.join(dir, "metadata.json"));
  });
}

function readMeta(id) {
  try {
    const file = path.join(storyRoot(), id, "metadata.json");
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function getActiveStory() {
  for (const id of listStoryIds()) {
    const m = readMeta(id);
    if (m && (m.active === true || m.active === "true")) {
      return { id, ...m };
    }
  }
  return null;
}

async function announceActiveStory(meta) {
  if (!meta) return;
  const channelId = BREAKING_CHANNEL_ID || DISCORD_FORUM_CHANNEL_ID;
  if (!channelId) {
    warn("No BREAKING_CHANNEL_ID / DISCORD_FORUM_CHANNEL_ID set; skipping announce");
    return;
  }

  try {
    const ch = await client.channels.fetch(channelId);
    if (!ch) return warn("Channel not found:", channelId);

    const title = meta.title || meta.id || "New Story";
    const subtitle = meta.subtitle ? `\n${meta.subtitle}` : "";
    const message = `📢 **Now Featuring:** ${title}${subtitle}`;

    // Try to attach a thumbnail if it exists on disk
    let files = [];
    const dir = path.join(storyRoot(), meta.id || "");
    const thumbCandidates = [meta.thumbnail, meta.youtubeThumbnail, meta.thumbnailYt].filter(Boolean);
    for (const t of thumbCandidates) {
      const p = path.join(dir, t);
      if (t && fs.existsSync(p) && fs.statSync(p).isFile()) {
        files = [new AttachmentBuilder(p)];
        break;
      }
    }

    await ch.send({ content: message, files });
    log("Announced active story:", meta.id || title);
  } catch (err) {
    warn("Announce failed:", err.message);
  }
}

// Watcher that notices when active story flips
function startWatcher() {
  let lastActiveId = (getActiveStory() || {}).id || null;

  const check = async () => {
    try {
      const cur = getActiveStory();
      const curId = cur ? cur.id : null;
      if (curId && curId !== lastActiveId) {
        lastActiveId = curId;
        await announceActiveStory(cur);
      }
    } catch (e) {
      // ignore
    }
  };

  // Poll every 10s (robust across platforms & containers)
  setInterval(check, 10_000);

  // Also try fs.watch for faster response when supported
  const root = storyRoot();
  if (fs.existsSync(root)) {
    try {
      fs.watch(root, { recursive: true }, () => {
        // debounce a touch
        setTimeout(check, 500);
      });
    } catch {
      // some filesystems don’t support recursive; polling already covers it
    }
  }
}

client.once("ready", async () => {
  log("Logged in as", client.user?.tag);
  // Announce current active on boot
  try { await announceActiveStory(getActiveStory()); } catch {}
  startWatcher();
});

if (!DISCORD_TOKEN) {
  warn("No DISCORD_TOKEN provided — bot not started.");
} else {
  client.login(DISCORD_TOKEN).catch((e) => warn("Login failed:", e.message));
}

module.exports = { getActiveStory, announceActiveStory };
