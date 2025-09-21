const { spawn } = require("child_process");

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "inherit", "inherit"] });
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(cmd + " exited " + code))));
  });
}

async function makeVoicemailVideo(mp3Path, mp4Out, imagePath) {
  const ffmpeg = process.env.FFMPEG_PATH || "ffmpeg";

  const hasImage = !!imagePath;
  const vf = hasImage
    ? [
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
