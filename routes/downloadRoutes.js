const express = require("express");
const router = express.Router();
const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");
const Download = require("../models/Download");

const cookiesPath = path.join(__dirname, "../cookies.txt");
const downloadDir = path.join(__dirname, "../downloads");
if (!fs.existsSync(downloadDir)) fs.mkdirSync(downloadDir, { recursive: true });

// =====================
// HELPER: Delete file safely
// =====================
function deleteFile(filePath) {
  setTimeout(() => {
    if (fs.existsSync(filePath)) fs.unlink(filePath, () => {});
  }, 5000);
}

// =====================
// HELPER: Run yt-dlp via execFile
// =====================
function runYtDlp(args) {
  return new Promise((resolve, reject) => {
    // Windows pe .exe, Linux/Render pe plain yt-dlp
    const bin = process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp";

    if (fs.existsSync(cookiesPath)) {
      args = ["--cookies", cookiesPath, ...args];
    }

    execFile(bin, args, { maxBuffer: 1024 * 1024 * 20 }, (err, stdout, stderr) => {
      if (err) reject({ stdout, stderr, message: err.message });
      else resolve({ stdout, stderr });
    });
  });
}

// =====================
// HELPER: Strip YouTube tracking params
// =====================
function cleanUrl(url) {
  try {
    const u = new URL(url);
    u.searchParams.delete("si");
    u.searchParams.delete("feature");
    return u.toString();
  } catch {
    return url;
  }
}

// =====================
// HELPER: Estimate size
// =====================
function estimateSize(f, duration) {
  if (f.filesize) return f.filesize;
  if (f.filesize_approx) return f.filesize_approx;
  if (f.tbr && duration) return Math.round((f.tbr * 1000 / 8) * duration);
  if (f.vbr && duration) return Math.round((f.vbr * 1000 / 8) * duration);
  return null;
}

// =====================
// HELPER: Filter & deduplicate formats
// =====================
function filterFormats(formats = [], duration = 0) {
  const allowedHeights = [2160, 1440, 1080, 720, 480];
  const seen = new Set();
  const filtered = [];

  for (const f of formats) {
    const isVideo = f.vcodec && f.vcodec !== "none";
    const isSupportedExt = f.ext === "mp4" || f.ext === "webm";

    if (isVideo && isSupportedExt && f.height && allowedHeights.includes(f.height) && !seen.has(f.height)) {
      seen.add(f.height);
      filtered.push({
        format_id: f.format_id,
        quality:
          f.height === 2160 ? "4K (2160p)" :
          f.height === 1440 ? "2K (1440p)" :
          `${f.height}p`,
        height: f.height,
        ext: "mp4",
        filesize: estimateSize(f, duration),
      });
    }
  }

  filtered.sort((a, b) => b.height - a.height);
  filtered.unshift({ format_id: "ORIGINAL_BEST", quality: "Original (Best)", height: 99999, ext: "mp4", filesize: null });
  return filtered;
}

// =====================
// FETCH MEDIA INFO
// =====================
router.post("/", async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: "URL is required" });

    const url2 = cleanUrl(url);

    const args = ["--dump-single-json", "--no-warnings", "--no-playlist", url2];

    const { stdout } = await runYtDlp(args);
    const data = JSON.parse(stdout);

    const formats = filterFormats(data.formats || [], data.duration || 0);

    Download.create({ url: url2, title: data.title, thumbnail: data.thumbnail, formats }).catch(() => {});

    res.json({
      title: data.title,
      thumbnail: data.thumbnail,
      duration: data.duration,
      formats,
      cleanUrl: url2,
    });

  } catch (err) {
    console.error("Fetch error:", err);
    res.status(500).json({ error: "Failed to fetch media info. Check the URL." });
  }
});

// =====================
// VIDEO DOWNLOAD
// =====================
router.get("/video", async (req, res) => {
  const { url, format_id } = req.query;
  if (!url || !format_id) return res.status(400).json({ error: "Missing url or format_id" });

  const url2 = cleanUrl(url);
  const fileName = `video_${Date.now()}.mp4`;
  const filePath = path.join(downloadDir, fileName);

  const formatArg = format_id === "ORIGINAL_BEST" ? "bestvideo+bestaudio/best" : `${format_id}+bestaudio/best`;
  const args = ["-f", formatArg, "--merge-output-format", "mp4", "--no-playlist", "-o", filePath, url2];

  try {
    await runYtDlp(args);
  } catch (err1) {
    console.error("Merge failed:", err1.stderr);
    const fallbackArgs = ["-f", "best[ext=mp4]/best", "--no-playlist", "-o", filePath, url2];
    try {
      await runYtDlp(fallbackArgs);
    } catch (err2) {
      console.error("Fallback failed:", err2.stderr);
      return res.status(500).json({ error: "Video download failed", detail: err2.stderr });
    }
  }

  let actualPath = filePath;
  if (!fs.existsSync(filePath)) {
    const base = filePath.replace(/\.mp4$/, "");
    const alt = [".mp4", ".mkv", ".webm"].map(e => base + e).find(p => fs.existsSync(p));
    if (alt) actualPath = alt;
    else return res.status(500).json({ error: "Output file not found" });
  }

  const ext = path.extname(actualPath).slice(1) || "mp4";
  res.download(actualPath, `video.${ext}`, (err) => {
    if (err) console.error("Send error:", err.message);
    deleteFile(actualPath);
  });
});

// =====================
// AUDIO DOWNLOAD
// =====================
router.get("/audio", async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: "Missing url" });

  const url2 = cleanUrl(url);
  const baseName = `audio_${Date.now()}`;
  const filePath = path.join(downloadDir, baseName + ".mp3");

  const args = ["-f", "bestaudio", "--extract-audio", "--audio-format", "mp3", "--audio-quality", "0", "--no-playlist", "-o", filePath, url2];

  let actualPath = null;

  try {
    await runYtDlp(args);
    actualPath = filePath;
  } catch (err1) {
    console.error("MP3 failed:", err1.stderr);
    const rawPath = path.join(downloadDir, baseName + ".%(ext)s");
    const fallbackArgs = ["-f", "bestaudio", "--no-playlist", "-o", rawPath, url2];
    try {
      await runYtDlp(fallbackArgs);
      const files = fs.readdirSync(downloadDir).filter(f => f.startsWith(baseName));
      if (files.length > 0) actualPath = path.join(downloadDir, files[0]);
    } catch (err2) {
      console.error("Audio fallback failed:", err2.stderr);
      return res.status(500).json({ error: "Audio download failed", detail: err2.stderr });
    }
  }

  if (!actualPath || !fs.existsSync(actualPath)) {
    return res.status(500).json({ error: "Audio file not found after download" });
  }

  const ext = path.extname(actualPath).slice(1) || "mp3";
  res.download(actualPath, `audio.${ext}`, (err) => {
    if (err) console.error("Send error:", err.message);
    deleteFile(actualPath);
  });
});

module.exports = router;