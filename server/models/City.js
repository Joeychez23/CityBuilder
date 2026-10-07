const mongoose = require("mongoose");

// A saved city. `data` is the game's packed save (gzip + base64, prefixed "GZ:"), stored as
// one string; the other fields are a summary so the city list loads without the save itself.
const MAX_SAVE_CHARS = 12 * 1024 * 1024;

const citySchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    name: { type: String, trim: true, maxlength: 60, default: "Untitled city" },
    mapId: { type: String, maxlength: 60, default: "" },
    mapName: { type: String, maxlength: 80, default: "" },
    climate: { type: String, maxlength: 30, default: "" },
    population: { type: Number, min: 0, default: 0 },
    money: { type: Number, default: 0 },
    day: { type: Number, min: 0, default: 0 },
    milestone: { type: Number, min: 0, max: 20, default: 0 },
    data: { type: String, required: true, select: false, maxlength: MAX_SAVE_CHARS },
    size: { type: Number, min: 0, default: 0 },
  },
  { timestamps: true }
);

citySchema.index({ user: 1, updatedAt: -1 });

citySchema.methods.toPublic = function toPublic() {
  return {
    id: this._id.toString(),
    name: this.name,
    mapId: this.mapId,
    mapName: this.mapName,
    climate: this.climate,
    population: this.population,
    money: this.money,
    day: this.day,
    milestone: this.milestone,
    size: this.size,
    createdAt: this.createdAt,
    updatedAt: this.updatedAt,
  };
};

module.exports = mongoose.model("City", citySchema);
module.exports.MAX_SAVE_CHARS = MAX_SAVE_CHARS;
