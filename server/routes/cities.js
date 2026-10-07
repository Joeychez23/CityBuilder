const express = require("express");
const mongoose = require("mongoose");
const City = require("../models/City");
const { requireDb, requireAuth } = require("../middleware/auth");
const rateLimit = require("../middleware/rateLimit");

const router = express.Router();
const MAX_CITIES = 20;
const saveLimiter = rateLimit({ name: "city-save", windowMs: 60_000, max: 30 });

router.use(requireDb, requireAuth);

const num = (v, min = -Infinity, max = Infinity) => (Number.isFinite(Number(v)) ? Math.min(max, Math.max(min, Number(v))) : undefined);
const str = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : undefined);

// Only known fields are copied from the request; the save string must look like one of ours.
function pickCity(body = {}) {
  const out = {};
  if (str(body.name, 60) !== undefined) out.name = str(body.name, 60) || "Untitled city";
  for (const [k, max] of [["mapId", 60], ["mapName", 80], ["climate", 30]]) if (str(body[k], max) !== undefined) out[k] = str(body[k], max);
  for (const [k, lo, hi] of [["population", 0, 1e9], ["money", -1e13, 1e13], ["day", 0, 1e6], ["milestone", 0, 20]]) {
    if (num(body[k], lo, hi) !== undefined) out[k] = num(body[k], lo, hi);
  }
  if (body.data !== undefined) {
    if (typeof body.data !== "string" || !(body.data.startsWith("GZ:") || body.data.startsWith("{"))) {
      const err = new Error("That doesn't look like a city save.");
      err.status = 400;
      throw err;
    }
    if (body.data.length > City.MAX_SAVE_CHARS) {
      const err = new Error("This city is too large to save to your account.");
      err.status = 413;
      throw err;
    }
    out.data = body.data;
    out.size = body.data.length;
  }
  return out;
}

function findOwned(req, withData = false) {
  if (!mongoose.isValidObjectId(req.params.id)) return null;
  const q = City.findOne({ _id: req.params.id, user: req.userId });
  return withData ? q.select("+data") : q;
}

router.get("/", async (req, res) => {
  const cities = await City.find({ user: req.userId }).sort({ updatedAt: -1 }).limit(MAX_CITIES);
  res.json({ cities: cities.map((c) => c.toPublic()) });
});

router.post("/", saveLimiter, async (req, res) => {
  if ((await City.countDocuments({ user: req.userId })) >= MAX_CITIES) {
    return res.status(409).json({ error: `You can keep up to ${MAX_CITIES} cities. Delete one to save another.` });
  }
  const data = pickCity(req.body);
  if (!data.data) return res.status(400).json({ error: "Nothing to save." });
  const city = await City.create({ ...data, user: req.userId });
  res.status(201).json({ city: city.toPublic() });
});

router.get("/:id", async (req, res) => {
  const city = await findOwned(req, true);
  if (!city) return res.status(404).json({ error: "City not found." });
  res.json({ city: { ...city.toPublic(), data: city.data } });
});

router.put("/:id", saveLimiter, async (req, res) => {
  const city = await findOwned(req);
  if (!city) return res.status(404).json({ error: "City not found." });
  Object.assign(city, pickCity(req.body));
  await city.save();
  res.json({ city: city.toPublic() });
});

router.delete("/:id", async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: "City not found." });
  const result = await City.deleteOne({ _id: req.params.id, user: req.userId });
  if (!result.deletedCount) return res.status(404).json({ error: "City not found." });
  res.status(204).end();
});

module.exports = router;
