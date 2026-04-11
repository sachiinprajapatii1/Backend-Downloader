const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const dotenv = require("dotenv");
const fs = require("fs");
const path = require("path");

dotenv.config();

// YouTube cookies from base64
if (process.env.YOUTUBE_COOKIES_B64) {
  const decoded = Buffer.from(process.env.YOUTUBE_COOKIES_B64, "base64").toString("utf8");
  fs.writeFileSync(path.join(__dirname, "cookies.txt"), decoded);
  console.log("✓ YouTube cookies written from base64");
}

// Instagram cookies from base64
if (process.env.INSTAGRAM_COOKIES_B64) {
  let decoded = Buffer.from(process.env.INSTAGRAM_COOKIES_B64, "base64").toString("utf8");
  // BOM remove karo
  decoded = decoded.replace(/^\uFEFF/, "");
  fs.writeFileSync(path.join(__dirname, "ig_cookies.txt"), decoded, "utf8");
  console.log("✓ Instagram cookies written, first line:", decoded.split("\n")[0]);
}

const downloadRoutes = require("./routes/downloadRoutes");

const app = express();
app.use(cors());
app.use(express.json());
app.use("/api/download", downloadRoutes);

mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log("✓ MongoDB Connected"))
  .catch(err => console.log("MongoDB error:", err));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`✓ Server running on port ${PORT}`));