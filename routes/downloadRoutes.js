const express = require("express");
const router = express.Router();
const { execFile, exec } = require("child_process");
const fs = require("fs");
const path = require("path");
const Download = require("../models/Download");

const cookiesPath = path.join(__dirname, "../cookies.txt");
const igCookiesPath = path.join(__dirname, "../ig_cookies.txt");
const downloadDir = path.join(__dirname, "../downloads");
if (!fs.existsSync(downloadDir)) fs.mkdirSync(downloadDir, { recursive: true });

function deleteFile(filePath) {
  setTimeout(() => {
    if (fs.existsSync(filePath)) fs.unlink(filePath, () => {});
  }, 5000);
}

function getYtDlpBin() {
  try {
    const pkgDir = path.dirname(require.resolve("yt-dlp-exec/package.json"));
    const bin = path.join(pkgDir, "bin", process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp");
    if (fs.existsSync(bin)) return bin;
  } catch {}
  const localBin = path.join(__dirname, "../yt-dlp");
  if (fs.existsSync(localBin)) return localBin;
  return process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp";
}

function getCookieArgs(useIgCookies = false) {
  if (useIgCookies && fs.existsSync(igCookiesPath)) return ["--cookies", igCookiesPath];
  if (fs.existsSync(cookiesPath)) return ["--cookies", cookiesPath];
  return [];
}

// Normal runYtDlp — fails on stderr errors
function runYtDlp(args, useIgCookies = false) {
  return new Promise((resolve, reject) => {
    const bin = getYtDlpBin();
    const cookieArgs = getCookieArgs(useIgCookies);
    const finalArgs = [...cookieArgs, ...args];
    execFile(bin, finalArgs, { maxBuffer: 1024 * 1024 * 20 }, (err, stdout, stderr) => {
      if (err) reject({ stdout, stderr, message: err.message });
      else resolve({ stdout, stderr });
    });
  });
}

// Lenient runYtDlp — tries to parse stdout even if there are errors
// Used for Instagram carousel where "No video formats" errors appear but JSON is still valid
function runYtDlpLenient(args, useIgCookies = false) {
  return new Promise((resolve, reject) => {
    const bin = getYtDlpBin();
    const cookieArgs = getCookieArgs(useIgCookies);
    const finalArgs = [...cookieArgs, ...args];
    execFile(bin, finalArgs, { maxBuffer: 1024 * 1024 * 20 }, (err, stdout, stderr) => {
      // Try to parse stdout even if there's an error
      if (stdout && stdout.trim()) {
        resolve({ stdout, stderr });
      } else if (err) {
        reject({ stdout, stderr, message: err.message });
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

function cleanUrl(url) {
  try {
    const u = new URL(url);
    u.searchParams.delete("si");
    u.searchParams.delete("feature");
    u.searchParams.delete("utm_source");
    u.searchParams.delete("igsh");
    return u.toString();
  } catch { return url; }
}

function isInstagram(url) { return url.includes("instagram.com"); }

function estimateSize(f, duration) {
  if (f.filesize) return f.filesize;
  if (f.filesize_approx) return f.filesize_approx;
  if (f.tbr && duration) return Math.round((f.tbr * 1000 / 8) * duration);
  if (f.vbr && duration) return Math.round((f.vbr * 1000 / 8) * duration);
  return null;
}

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
        quality: f.height === 2160 ? "4K (2160p)" : f.height === 1440 ? "2K (1440p)" : `${f.height}p`,
        height: f.height, ext: "mp4", filesize: estimateSize(f, duration),
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
    const ig = isInstagram(url2);
    const args = ["--dump-single-json", "--no-warnings", url2];

    let data;
    try {
      // Use lenient mode for Instagram — handles photo/carousel "No video formats" errors
      const { stdout } = ig ? await runYtDlpLenient(args, true) : await runYtDlp(args, false);
      
      // Find JSON in stdout — it might have error lines before it
      const jsonStart = stdout.indexOf("{");
      if (jsonStart === -1) throw new Error("No JSON in stdout");
      data = JSON.parse(stdout.slice(jsonStart));
    } catch (e) {
      console.error("Parse error:", e.message);
      return res.status(500).json({ error: "Failed to fetch media info. Check the URL." });
    }

    const isCarousel = data._type === "playlist";
    const formats = filterFormats(data.formats || [], data.duration || 0);
    const isPhoto = !isCarousel && formats.length === 1;

    Download.create({ url: url2, title: data.title, thumbnail: data.thumbnail, formats }).catch(() => {});

    res.json({
      title: data.title,
      thumbnail: data.thumbnail,
      duration: data.duration,
      formats,
      isPhoto,
      isCarousel,
      itemCount: isCarousel ? (data.playlist_count || 0) : 0,
      cleanUrl: url2,
    });

  } catch (err) {
    console.error("Fetch error:", err);
    res.status(500).json({ error: "Failed to fetch media info. Check the URL." });
  }
});

// =====================
// CAROUSEL ITEMS FETCH
// =====================
router.get("/carousel", (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: "Missing url" });

  const url2 = cleanUrl(url);
  const cookieArg = fs.existsSync(igCookiesPath) ? igCookiesPath : fs.existsSync(cookiesPath) ? cookiesPath : null;

  const sessionId = Date.now();
  const outputDir = path.join(downloadDir, `carousel_${sessionId}`);
  fs.mkdirSync(outputDir, { recursive: true });

  const cookieFlag = cookieArg ? `--cookies "${cookieArg}"` : "";
  const command = `gallery-dl ${cookieFlag} --directory "${outputDir}" "${url2}"`;

  console.log("gallery-dl:", command);

  exec(command, { maxBuffer: 1024 * 1024 * 50 }, (err, stdout, stderr) => {
    const items = [];
    try {
      const walk = (dir) => {
        if (!fs.existsSync(dir)) return;
        const files = fs.readdirSync(dir);
        for (const file of files) {
          const fullPath = path.join(dir, file);
          const stat = fs.statSync(fullPath);
          if (stat.isDirectory()) walk(fullPath);
          else {
            const ext = path.extname(file).toLowerCase();
            const isImg = [".jpg", ".jpeg", ".png", ".webp"].includes(ext);
            const isVid = [".mp4", ".webm", ".mov"].includes(ext);
            if (isImg || isVid) {
              items.push({ filename: file, type: isImg ? "photo" : "video", size: stat.size, sessionId });
            }
          }
        }
      };
      walk(outputDir);
    } catch (e) {
      console.error("Walk error:", e);
    }

    res.json({ items, sessionId });
  });
});

// =====================
// CAROUSEL THUMBNAIL SERVE
router.get("/carousel-thumb", (req, res) => {
  const { sessionId, filename } = req.query;
  if (!sessionId || !filename) return res.status(400).send("Missing params");
  const safeName = path.basename(filename);
  const outputDir = path.join(downloadDir, `carousel_${sessionId}`);
  const findFile = (dir) => {
    if (!fs.existsSync(dir)) return null;
    for (const file of fs.readdirSync(dir)) {
      const fullPath = path.join(dir, file);
      if (fs.statSync(fullPath).isDirectory()) { const f = findFile(fullPath); if (f) return f; }
      else if (file === safeName) return fullPath;
    }
    return null;
  };
  const filePath = findFile(outputDir);
  if (!filePath) return res.status(404).send("Not found");
  res.sendFile(filePath);
});

// CAROUSEL ITEM DOWNLOAD
// =====================
router.get("/carousel-item", (req, res) => {
  const { sessionId, filename } = req.query;
  if (!sessionId || !filename) return res.status(400).json({ error: "Missing params" });

  const safeName = path.basename(filename);
  const outputDir = path.join(downloadDir, `carousel_${sessionId}`);

  const findFile = (dir) => {
    if (!fs.existsSync(dir)) return null;
    const files = fs.readdirSync(dir);
    for (const file of files) {
      const fullPath = path.join(dir, file);
      const stat = fs.statSync(fullPath);
      if (stat.isDirectory()) { const found = findFile(fullPath); if (found) return found; }
      else if (file === safeName) return fullPath;
    }
    return null;
  };

  const filePath = findFile(outputDir);
  if (!filePath) return res.status(404).json({ error: "File not found" });

  res.download(filePath, safeName, (err) => {
    if (err) console.error("Send error:", err.message);
  });
});

// =====================
// VIDEO DOWNLOAD
// =====================
router.get("/video", async (req, res) => {
  const { url, format_id } = req.query;
  if (!url || !format_id) return res.status(400).json({ error: "Missing url or format_id" });

  const url2 = cleanUrl(url);
  const ig = isInstagram(url2);
  const fileName = `video_${Date.now()}.mp4`;
  const filePath = path.join(downloadDir, fileName);

  const formatArg = format_id === "ORIGINAL_BEST" ? "bestvideo+bestaudio/best" : `${format_id}+bestaudio/best`;

  try {
    await runYtDlp(["-f", formatArg, "--merge-output-format", "mp4", "--no-playlist", "-o", filePath, url2], ig);
  } catch (err1) {
    try {
      await runYtDlp(["-f", "best[ext=mp4]/best", "--no-playlist", "-o", filePath, url2], ig);
    } catch (err2) {
      try {
        await runYtDlp(["-f", "best", "--no-playlist", "-o", filePath, url2], ig);
      } catch (err3) {
        return res.status(500).json({ error: "Download failed", detail: err3.stderr });
      }
    }
  }

  let actualPath = filePath;
  if (!fs.existsSync(filePath)) {
    const base = path.basename(filePath, ".mp4");
    const files = fs.readdirSync(downloadDir).filter(f => f.startsWith(base));
    if (files.length > 0) actualPath = path.join(downloadDir, files[0]);
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
  const ig = isInstagram(url2);
  const baseName = `audio_${Date.now()}`;
  const filePath = path.join(downloadDir, baseName + ".mp3");

  let actualPath = null;
  try {
    await runYtDlp(["-f", "bestaudio", "--extract-audio", "--audio-format", "mp3", "--audio-quality", "0", "--no-playlist", "-o", filePath, url2], ig);
    actualPath = filePath;
  } catch (err1) {
    try {
      const rawPath = path.join(downloadDir, baseName + ".%(ext)s");
      await runYtDlp(["-f", "bestaudio", "--no-playlist", "-o", rawPath, url2], ig);
      const files = fs.readdirSync(downloadDir).filter(f => f.startsWith(baseName));
      if (files.length > 0) actualPath = path.join(downloadDir, files[0]);
    } catch (err2) {
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