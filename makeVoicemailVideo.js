// makeVoicemailVideo.js
// Build a Discord-friendly MP4 (H.264/AAC) from an MP3 + optional thumbnail.
// - If thumb provided & exists: loop that image as video
// - Else: synthetic black background at 1280x720
// Output: faststart MP4, yuv420p, ends with audio (shortest)

const fs = require("fs");
const path = require("path");
const ffmpegPath = require("@ffmpeg-installer/ffmpeg").path;
const ffmpeg = require("fluent-ffmpeg");
ffmpeg.setFfmpegPath(ffmpegPath);

/**
 * @param {string} mp3Abs absolute path to source MP3
 * @param {string} mp4Abs absolute path to target MP4
 * @param {string|undefined} thumbAbs absolute path to thumbnail image (optional)
 * @returns {Promise<void>}
 */
module.exports = function makeVoicemailVideo(mp3Abs, mp4Abs, thumbAbs) {
  return new Promise((resolve, reject) => {
    try {
      if (!mp3Abs || !fs.existsSync(mp3Abs)) {
        return reject(new Error("Audio file not found: " + mp3Abs));
      }
      // ensure output dir exists
      const outDir = path.dirname(mp4Abs);
      if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

      const haveThumb = !!thumbAbs && fs.existsSync(thumbAbs);

      // Build command
      const cmd = ffmpeg();

      if (haveThumb) {
        // Use the image as a looping video layer
        cmd.input(thumbAbs).inputOptions(["-loop 1"]);
      } else {
        // Use a synthetic black background if no image
        cmd
          .input("color=c=black:s=1280x720:d=36000")
          .inputOptions(["-f lavfi"]);
      }

      // Add audio
      cmd.input(mp3Abs);

      // Scale/pad (only meaningful if we had an image; harmless on black)
      // Ensure 1280x720 letterbox, preserve aspect
      cmd.videoFilters([
        "scale=1280:-2",
        "pad=1280:720:(ow-iw)/2:(oh-ih)/2"
      ]);

      cmd
        .outputOptions([
          "-c:v libx264",
          "-tune stillimage",    // good for static images
          "-pix_fmt yuv420p",    // Discord/mobile compatibility
          "-c:a aac",
          "-b:a 128k",
          "-movflags +faststart",
          "-shortest"            // stop when audio ends
        ])
        .on("start", (cli) => {
          console.log("[ffmpeg] start:", cli);
        })
        .on("error", (err, stdout, stderr) => {
          console.error("[ffmpeg] error:", err?.message || err);
          if (stderr) console.error(stderr);
          reject(err);
        })
        .on("end", () => {
          console.log("[ffmpeg] done:", mp4Abs);
          resolve();
        })
        .save(mp4Abs);
    } catch (e) {
      reject(e);
    }
  });
};
