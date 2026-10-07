const express = require("express");
const bcrypt = require("bcrypt");
const User = require("../models/User");
const City = require("../models/City");
const { signToken, requireDb, requireAuth } = require("../middleware/auth");
const rateLimit = require("../middleware/rateLimit");

const router = express.Router();
const BCRYPT_ROUNDS = 12;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// A real hash so failed logins for unknown emails take as long as wrong passwords.
const DUMMY_HASH = bcrypt.hashSync("gridlock-city-timing-guard", BCRYPT_ROUNDS);

const authLimiter = rateLimit({ name: "auth", windowMs: 15 * 60_000, max: 30 });

router.use(requireDb);

router.post("/register", authLimiter, async (req, res) => {
  const { email, password, name } = req.body || {};
  if (typeof email !== "string" || !EMAIL.test(email.trim())) {
    return res.status(400).json({ error: "Enter a valid email address." });
  }
  if (typeof password !== "string" || password.length < 8 || password.length > 128) {
    return res.status(400).json({ error: "Use a password between 8 and 128 characters." });
  }
  const normalized = email.trim().toLowerCase();
  if (await User.exists({ email: normalized })) {
    return res.status(409).json({ error: "An account with that email already exists. Try signing in." });
  }
  const user = await User.create({
    email: normalized,
    name: typeof name === "string" ? name.trim().slice(0, 80) : "",
    passwordHash: await bcrypt.hash(password, BCRYPT_ROUNDS),
  });
  res.status(201).json({ token: signToken(user), user: user.toPublic() });
});

router.post("/login", authLimiter, async (req, res) => {
  const { email, password } = req.body || {};
  if (typeof email !== "string" || typeof password !== "string") {
    return res.status(400).json({ error: "Email and password are required." });
  }
  const user = await User.findOne({ email: email.trim().toLowerCase() }).select("+passwordHash");
  const ok = await bcrypt.compare(password, user ? user.passwordHash : DUMMY_HASH);
  if (!user || !ok) return res.status(401).json({ error: "That email and password don't match." });
  res.json({ token: signToken(user), user: user.toPublic() });
});

router.get("/me", requireAuth, async (req, res) => {
  const user = await User.findById(req.userId);
  if (!user) return res.status(401).json({ error: "Your account no longer exists." });
  res.json({ user: user.toPublic() });
});

// Deletes the account and every city saved for it.
router.delete("/account", requireAuth, async (req, res) => {
  await City.deleteMany({ user: req.userId });
  await User.findByIdAndDelete(req.userId);
  res.status(204).end();
});

module.exports = router;
