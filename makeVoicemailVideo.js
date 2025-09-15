const path = require('path');
const fs = require('fs');
const os = require('os');
const ffmpegPath = require('ffmpeg-static');
const ffmpeg = require('fluent-ffmpeg');
ffmpeg.setFfmpegPath(ffmpegPath);

// imagePath: path to thumb_YT.png
// audioPath: path to voicemail.mp3
// watermarkPath (optional): overlay logo png
async function makeVoicemailVideo({ imagePath, audioPath, outName = 'voicemail_poster.mp4', watermarkPath = null }) {
  const outPath = path.join(os.tmpdir(), outName);

  return new Promise((resolve, reject) => {
    let chain = ffmpeg()
      .input(imagePath).inputOptions(['-loop 1'])
      .input(audioPath)
      .videoCodec('libx264')
      .audioCodec('aac')
      .size('1280x?') // 16:9 thumb should already be fine; 1280 keeps files small
      .outputOptions([
        '-preset veryfast',
        '-profile:v high', '-level 4.0',
        '-pix_fmt yuv420p',
        '-movflags +faststart',
        '-shortest',
        // keep size friendly for Discord
        '-b:v 900k', '-maxrate 1000k', '-bufsize 2000k', '-r 30',
      ])
      .format('mp4');

    if (watermarkPath) {
      chain = chain.complexFilter([
        { filter: 'scale', options: '1280:-2', inputs: '0:v', outputs: 'bg' },
        { filter: 'format', options: 'yuv420p', inputs: 'bg', outputs: 'bgf' },
        { filter: 'movie', options: watermarkPath, outputs: 'wm' },
        { filter: 'overlay', options: '(W-w)/2:(H-h)/2:format=auto', inputs: ['bgf', 'wm'], outputs: 'vout' },
      ], 'vout');
    }

    chain
      .save(outPath)
      .on('end', () => resolve(outPath))
      .on('error', reject);
  });
}

module.exports = { makeVoicemailVideo };
