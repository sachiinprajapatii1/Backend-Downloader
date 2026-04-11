const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const dotenv = require("dotenv");
const fs = require("fs");
const path = require("path");

dotenv.config();

// YouTube cookies
if (process.env.YOUTUBE_COOKIES) {
  fs.writeFileSync(path.join(__dirname, "cookies.txt"), process.env.YOUTUBE_COOKIES);
  console.log("✓ YouTube cookies written");
} else {
  console.log("⚠ No YOUTUBE_COOKIES env variable found");
}

// Instagram cookies
if (process.env.INSTAGRAM_COOKIES) {
  fs.writeFileSync(path.join(__dirname, "ig_cookies.txt"), process.env.INSTAGRAM_COOKIES);
  console.log("✓ Instagram cookies written");
} else {
  console.log("⚠ No INSTAGRAM_COOKIES env variable found");
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