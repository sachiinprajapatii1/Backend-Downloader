const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const dotenv = require("dotenv");
const fs = require("fs");
const path = require("path");

dotenv.config();

// Write YouTube cookies from env variable to file at startup
if (process.env.YOUTUBE_COOKIES) {
  const cookiePath = path.join(__dirname, "cookies.txt");
  fs.writeFileSync(cookiePath, process.env.YOUTUBE_COOKIES);
  console.log("✓ YouTube cookies written");
} else {
  console.log("⚠ No YOUTUBE_COOKIES env variable found");
}

const downloadRoutes = require("./routes/downloadRoutes");

const app = express();


app.use(express.json());
app.use(cors());

app.use("/api/download", downloadRoutes);

mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log("✓ MongoDB Connected"))
  .catch(err => console.log("MongoDB error:", err));

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`✓ Server running on port ${PORT}`);
});