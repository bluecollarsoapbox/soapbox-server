// makeVoicemailVideo.js
// Input: mp3Path, mp4Out, optional imagePath
// Produces: H.264/AAC MP4 with moov at start, safe for Discord/iOS inline playback

const { spawn } = require("child_process");
const path = require("path");

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "inherit", "inherit"] });
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(cmd + " exited " + code))));
  });
}

async function makeVoicemailVideo(mp3Path, mp4Out, imagePath) {
  // Build ffmpeg args:
  // - Use a still frame (YT thumb if provided, otherwise black) + the MP3
  // - Encode H.264 Baseline, yuv420p (widest compatibility), AAC audio
  // - Put moov atom up front for instant start (-movflags +faststart)
  // - Match common mobile friendly canvas: 1280 wide, preserve aspect for image
  const ffmpeg = process.env.FFMPEG_PATH || "ffmpeg";

  const hasImage = !!imagePath;
  const vf = hasImage
    ? [
        // scale image to 1280 width, keep aspect, pad to 1280x720
        "scale='min(1280,iw)':'min(720,ih)':force_original_aspect_ratio=decrease",
        "pad=1280:720:(1280-iw)/2:(720-ih)/2:color=black",
        "format=yuv420p"
      ].join(",")
    : "color=c=black:s=1280x720,format=yuv420p";

  const inputs = hasImage
    ? ["-loop", "1", "-i", imagePath, "-i", mp3Path]
    : ["-f", "lavfi", "-i", "color=c=black:s=1280x720", "-i", mp3Path];

  const args = [
    ...inputs,
    "-shortest",
    "-r", "30",
    "-c:v", "libx264",
    "-profile:v", "baseline",
    "-level", "3.0",
    "-pix_fmt", "yuv420p",
    "-vf", vf,
    "-c:a", "aac",
    "-b:a", "128k",
    "-movflags", "+faststart",
    "-y",
    mp4Out
  ];

  await run(ffmpeg, args);
}

module.exports = makeVoicemailVideo;
