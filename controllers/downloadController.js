import { exec } from "child_process";
import fs from "fs";
import { fileURLToPath } from "url";
import path from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const downloadPath = path.join(__dirname, "../downloads");

// Ensure downloads folder exists
if (!fs.existsSync(downloadPath)) {
  fs.mkdirSync(downloadPath, { recursive: true });
}

// =====================
// HELPER: Delete file safely (delayed)
// =====================
function deleteFile(filePath) {
  setTimeout(() => {
    if (fs.existsSync(filePath)) {
      fs.unlink(filePath, () => {});
    }
  }, 5000);
}

// =====================
// HELPER: Filter & deduplicate formats
// =====================
function filterFormats(formats = []) {
  const allowedHeights = [2160, 1440, 1080, 720, 480];
  const seen = new Set();
  const filtered = [];

  for (const f of formats) {
    // Accept mp4 OR webm — YouTube Shorts often only have webm, not mp4
    const isVideo = f.vcodec && f.vcodec !== "none";
    const isSupportedExt = f.ext === "mp4" || f.ext === "webm";

    if (
      isVideo &&
      isSupportedExt &&
      f.height &&
      allowedHeights.includes(f.height) &&
      !seen.has(f.height)
    ) {
      seen.add(f.height);
      filtered.push({
        format_id: f.format_id,
        quality:
          f.height === 2160 ? "4K (2160p)" :
          f.height === 1440 ? "2K (1440p)" :
          `${f.height}p`,
        height: f.height,
        ext: "mp4", // always output as mp4 via --merge-output-format
      });
    }
  }

  // Sort descending by height
  filtered.sort((a, b) => b.height - a.height);

  // Always add "Original (Best)" at the top
  // Using ORIGINAL_BEST as a safe custom flag (not a yt-dlp keyword)
  filtered.unshift({
    format_id: "ORIGINAL_BEST",
    quality: "Original (Best)",
    height: 99999,
    ext: "mp4",
  });

  return filtered;
}

// =====================
// FETCH VIDEO INFO
// =====================
export const getVideoInfo = (req, res) => {
  const { url } = req.body;

  if (!url) return res.status(400).json({ error: "URL is required" });

  const command = `yt-dlp -j --no-warnings --no-playlist "${url}"`;

  exec(command, { maxBuffer: 1024 * 1024 * 10 }, (err, stdout, stderr) => {
    if (err) {
      console.error("Info fetch error:", stderr);
      return res.status(500).json({ error: "Failed to fetch media info. Check the URL." });
    }

    let data;
    try {
      data = JSON.parse(stdout);
    } catch {
      return res.status(500).json({ error: "Invalid response from yt-dlp" });
    }

    const formats = filterFormats(data.formats);

    res.json({
      title: data.title,
      thumbnail: data.thumbnail,
      duration: data.duration,
      formats,
    });
  });
};

// =====================
// VIDEO DOWNLOAD (WITH AUDIO MERGED)
// =====================
export const downloadVideo = (req, res) => {
  const { url, format_id } = req.query;

  if (!url || !format_id) {
    return res.status(400).json({ error: "Missing url or format_id" });
  }

  const fileName = `video_${Date.now()}.mp4`;
  const filePath = path.join(downloadPath, fileName);

  // ORIGINAL_BEST is our safe custom flag → map to yt-dlp selector
  const formatArg =
    format_id === "ORIGINAL_BEST"
      ? "bestvideo+bestaudio/best"
      : `${format_id}+bestaudio/best`;

  const command = `yt-dlp -f "${formatArg}" --merge-output-format mp4 --no-playlist -o "${filePath}" "${url}"`;

  console.log("Running:", command);

  exec(command, { maxBuffer: 1024 * 1024 * 10 }, (err, stdout, stderr) => {
    if (err) {
      console.error("Video download error:", stderr);
      return res.status(500).json({ error: "Video download failed: " + stderr });
    }

    if (!fs.existsSync(filePath)) {
      return res.status(500).json({ error: "File not created after download" });
    }

    res.download(filePath, "video.mp4", (sendErr) => {
      if (sendErr) console.error("File send error:", sendErr.message);
      deleteFile(filePath);
    });
  });
};

// =====================
// AUDIO DOWNLOAD (MP3)
// =====================
export const downloadAudio = (req, res) => {
  const { url } = req.query;

  if (!url) return res.status(400).json({ error: "Missing url" });

  const fileName = `audio_${Date.now()}.mp3`;
  const filePath = path.join(downloadPath, fileName);

  const command = `yt-dlp -f bestaudio --extract-audio --audio-format mp3 --audio-quality 0 --no-playlist -o "${filePath}" "${url}"`;

  console.log("Running:", command);

  exec(command, { maxBuffer: 1024 * 1024 * 10 }, (err, stdout, stderr) => {
    if (err) {
      console.error("Audio download error:", stderr);
      return res.status(500).json({ error: "Audio download failed: " + stderr });
    }

    const actualPath = fs.existsSync(filePath)
      ? filePath
      : filePath.replace(/\.mp3$/, "") + ".mp3";

    if (!fs.existsSync(actualPath)) {
      return res.status(500).json({ error: "Audio file not found after download" });
    }

    res.download(actualPath, "audio.mp3", (sendErr) => {
      if (sendErr) console.error("File send error:", sendErr.message);
      deleteFile(actualPath);
    });
  });
};