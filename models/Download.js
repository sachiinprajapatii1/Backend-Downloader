const mongoose = require("mongoose");

const downloadSchema = new mongoose.Schema({
  url: { type: String, required: true },
  title: String,
  thumbnail: String,
  formats: Array,
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

module.exports = mongoose.model("Download", downloadSchema);