// makeVoicemailVideo.js
const fs = require("fs");
const path = require("path");
const ffmpeg = require("fluent-ffmpeg");

// Resolve an ffmpeg binary that works on Render
function resolveFfmpegPath() {
  // 1) Respect explicit env if you ever set it
  if (process.env.FFMPEG_PATH && fs.existsSync(process.env.FFMPEG_PATH)) {
    return process.env.FFMPEG_PATH;
  }
  // 2) Prefer ffmpeg-static (single package with prebuilt binaries)
  try {
    const staticPath = require("ffmpeg-static");
    if (staticPath && fs.existsSync(staticPath)) return staticPath;
  } catch (_) {}
  // 3) Fallback to @ffmpeg-installer/ffmpeg if present
  try {
    const inst = require("@ffmpeg-installer/ffmpeg");
    if (inst && inst.path && fs.existsSync(inst.path)) return inst.path;
  } catch (_) {}
  return null;
}

const ffmpegPath = resolveFfmpegPath();
if (!ffmpegPath) {
  console.error("[FFmpeg] Could not locate ffmpeg binary");
} else {
  ffmpeg.setFfmpegPath(ffmpegPath);
  console.log("[FFmpeg] Using:", ffmpegPath);
}

/**
 * Make an MP4 from an MP3 with an optional thumbnail still frame.
 * @param {string} mp3Path - absolute path to source MP3
 * @param {string} mp4Path - absolute path to output MP4
 * @param {string|undefined} thumbPath - absolute path to PNG/JPG thumbnail (optional)
 * @returns {Promise<void>}
 */
module.exports = function makeVoicemailVideo(mp3Path, mp4Path, thumbPath) {
  return new Promise((resolve, reject) => {
    if (!ffmpegPath) {
      return reject(new Error("FFmpeg not found. Install 'ffmpeg-static' or set FFMPEG_PATH."));
    }
    if (!fs.existsSync(mp3Path)) {
      return reject(new Error("MP3 not found: " + mp3Path));
    }

    // Ensure folder exists
    fs.mkdirSync(path.dirname(mp4Path), { recursive: true });

    const cmd = ffmpeg();

    if (thumbPath && fs.existsSync(thumbPath)) {
      // Use the provided image, loop it for the duration of the audio
      cmd.input(thumbPath)
         .inputOptions(["-framerate 2"]);
    } else {
      // No image? Generate a black canvas via lavfi
      cmd.input("color=black:s=1280x720:r=2")
         .inputOptions(["-f", "lavfi"]);
    }

    cmd.input(mp3Path)
       .outputOptions([
         "-c:v libx264",
         "-tune stillimage",
         "-c:a aac",
         "-b:a 192k",
         "-pix_fmt yuv420p",
         "-shortest",
         "-movflags +faststart"
       ])
       // If your art is 1280x720 this is a no-op; otherwise it letterboxes cleanly
       .videoFilters(["scale=1280:720:force_original_aspect_ratio=decrease", "pad=1280:720:(ow-iw)/2:(oh-ih)/2"])
       .on("start", (c) => console.log("[FFmpeg] start:", c))
       .on("error", (err, stdout, stderr) => {
         console.error("[FFmpeg] error:", err.message);
         if (stderr) console.error(stderr);
         reject(err);
       })
       .on("end", () => {
         console.log("[FFmpeg] done:", mp4Path);
         resolve();
       })
       .save(mp4Path);
  });
};
