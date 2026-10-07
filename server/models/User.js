const mongoose = require("mongoose");

// Same user document as Tone Radar: email + bcrypt hash, with optional display name.
const userSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true, maxlength: 254 },
    name: { type: String, trim: true, maxlength: 80, default: "" },
    passwordHash: { type: String, required: true, select: false },
  },
  { timestamps: true }
);

userSchema.methods.toPublic = function toPublic() {
  return {
    id: this._id.toString(),
    email: this.email,
    name: this.name,
    createdAt: this.createdAt,
  };
};

module.exports = mongoose.model("User", userSchema);
