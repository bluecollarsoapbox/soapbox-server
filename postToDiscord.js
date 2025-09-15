const { AttachmentBuilder, ChannelType } = require('discord.js');
const { client } = require('../bot'); // your existing logged-in Discord client

async function postToDiscordThread({ threadId, headline, caption, videoPath }) {
  const thread = await client.channels.fetch(threadId);
  if (!thread) throw new Error(`Thread ${threadId} not found`);
  if (thread.type !== ChannelType.PublicThread && thread.type !== ChannelType.PrivateThread) {
    throw new Error(`Channel ${threadId} is not a thread`);
  }

  // 1) headline + caption (like you do now)
  if (headline || caption) {
    await thread.send({
      content: `**${headline || ''}**\n${caption || ''}`.trim(),
    });
  }

  // 2) video file (plays inline)
  const file = new AttachmentBuilder(videoPath, { name: 'voicemail.mp4' });
  await thread.send({ files: [file] });
}

module.exports = { postToDiscordThread };
