// discordPoster.js — post witness video to Discord (thread if found)

const API_BASE = 'https://discord.com/api/v10';

/**
 * Posts the uploaded witness video to Discord.
 * If your `bot.js` sets `global.soapboxClient = client;` after login, we'll try
 * to find a thread named exactly like the storyTitle under BREAKING_NEWS_CHANNEL_ID.
 * If not found, we post directly in the channel.
 *
 * Env needed:
 * - DISCORD_TOKEN
 * - BREAKING_NEWS_CHANNEL_ID   (e.g. 1407176815285637313)
 */
async function postWitnessToDiscord({ storyId, storyTitle, buffer, filename, mime }) {
  const token = process.env.DISCORD_TOKEN;
  const channelId = process.env.BREAKING_NEWS_CHANNEL_ID; // Breaking News channel

  if (!token || !channelId) {
    console.error('[discordPoster] missing DISCORD_TOKEN or BREAKING_NEWS_CHANNEL_ID');
    return false;
  }

  // Try to locate an existing thread with the storyTitle using the running bot client (if available).
  let targetId = channelId;
  const client = global.soapboxClient; // <- set this in your bot.js once after login

  if (client) {
    try {
      const parent = await client.channels.fetch(channelId);
      // active threads
      const active = await parent.threads.fetchActive().catch(() => null);
      let thread =
        (active?.threads?.find?.((t) => t.name === storyTitle)) || null;

      // also check archived (optional; can be slow, skip if you want)
      if (!thread && parent.threads?.fetchArchived) {
        const archived = await parent.threads.fetchArchived().catch(() => null);
        thread =
          (archived?.threads?.find?.((t) => t.name === storyTitle)) || null;
      }

      if (thread?.id) {
        targetId = thread.id;
      }
    } catch (e) {
      // If anything fails, we’ll just post to the channel itself.
      console.warn('[discordPoster] thread lookup failed, posting to channel instead:', e?.message || e);
    }
  }

  // Build multipart form with Node 18 global fetch/FormData/Blob
  const form = new FormData();
  const payload = { content: `🎥 New witness video for **${storyTitle}**` };
  form.append('payload_json', JSON.stringify(payload));
  form.append('files[0]', new Blob([buffer], { type: mime || 'application/octet-stream' }), filename);

  const resp = await fetch(`${API_BASE}/channels/${targetId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bot ${token}` },
    body: form,
  });

  if (!resp.ok) {
    const txt = await resp.text().catch(() => '');
    console.error('[discordPoster] post failed:', resp.status, txt);
    return false;
  }

  return true;
}

module.exports = { postWitnessToDiscord };
