// makeVoicemailVideo.js
const fs = require("fs");
const path = require("path");
const ffmpeg = require("fluent-ffmpeg");

// Try to locate a usable ffmpeg binary without crashing the app
function setFfmpegPathIfAvailable() {
  // 1) Respect explicit env
  if (process.env.FFMPEG_PATH && fs.existsSync(process.env.FFMPEG_PATH)) {
    ffmpeg.setFfmpegPath(process.env.FFMPEG_PATH);
    console.log("[FFmpeg] Using (env):", process.env.FFMPEG_PATH);
    return true;
  }
  // 2) ffmpeg-static (best option if installed)
  try {
    const staticPath = require("ffmpeg-static");
    if (staticPath && fs.existsSync(staticPath)) {
      ffmpeg.setFfmpegPath(staticPath);
      console.log("[FFmpeg] Using (ffmpeg-static):", staticPath);
      return true;
    }
  } catch (_) {}
  // 3) @ffmpeg-installer/ffmpeg (guarded; this package can throw on require)
  try {
    const inst = require("@ffmpeg-installer/ffmpeg");
    if (inst && inst.path && fs.existsSync(inst.path)) {
      ffmpeg.setFfmpegPath(inst.path);
      console.log("[FFmpeg] Using (@ffmpeg-installer):", inst.path);
      return true;
    }
  } catch (_) {}
  // 4) Fall back to system ffmpeg on PATH
  console.warn("[FFmpeg] No bundled ffmpeg found; will rely on system ffmpeg on PATH");
  return false;
}

setFfmpegPathIfAvailable();

/**
 * Build a proper 1280x720 MP4 from MP3 + optional thumbnail.
 * - H.264 video, yuv420p, 30fps, +faststart
 * - Letterbox/pad art without distortion
 * - Ends when audio ends (-shortest)
 *
 * @param {string} mp3Path absolute path to input MP3
 * @param {string} mp4Path absolute path to output MP4
 * @param {string|undefined} thumbPath absolute path to PNG/JPG (optional)
 * @returns {Promise<void>}
 */
module.exports = function makeVoicemailVideo(mp3Path, mp4Path, thumbPath) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(mp3Path)) {
      return reject(new Error("MP3 not found: " + mp3Path));
    }

    fs.mkdirSync(path.dirname(mp4Path), { recursive: true });

    const cmd = ffmpeg();

    if (thumbPath && fs.existsSync(thumbPath)) {
      // Use still image; -loop 1 + set output fps at 30
      cmd.input(thumbPath).inputOptions(["-loop 1"]);
    } else {
      // No image: synthesize a 1280x720 dark canvas
      cmd.input("color=c=#0b0d10:s=1280x720:r=30").inputFormat("lavfi");
    }

    cmd.input(mp3Path);

    // Video filter: fit within 1280x720 then pad to full frame (no squish)
    const vf = [
      "scale=iw*min(1280/iw\\,720/ih):ih*min(1280/iw\\,720/ih)",
      "pad=1280:720:(1280-iw)/2:(720-ih)/2",
      "format=yuv420p",
    ].join(",");

    cmd
      .videoCodec("libx264")
      .outputOptions([
        "-preset veryfast",
        "-profile:v high",
        "-level 4.1",
        "-r 30",
        "-movflags +faststart",
        "-tune stillimage",
        `-vf ${vf}`,
      ])
      .audioCodec("aac")
      .audioBitrate("192k")
      .outputOptions(["-shortest"]) // stop when audio finishes
      .on("start", (c) => console.log("[FFmpeg] start:", c))
      .on("progress", (p) => {
        if (p?.frames) process.stdout.write(`\r[FFmpeg] frames: ${p.frames}   `);
      })
      .on("error", (err, _stdout, stderr) => {
        console.error("\n[FFmpeg] error:", err?.message || err);
        if (stderr) console.error(stderr);
        reject(err);
      })
      .on("end", () => {
        console.log("\n[FFmpeg] done:", mp4Path);
        resolve();
      })
      .save(mp4Path);
  });
};
