const jwt = require("jsonwebtoken");
const config = require("../config");
const { isConnected } = require("../db");

function signToken(user) {
  return jwt.sign({ sub: user._id.toString() }, config.jwtSecret, {
    expiresIn: config.jwtExpiresIn,
    algorithm: "HS256",
  });
}

function readToken(req) {
  const header = req.get("authorization") || "";
  const [scheme, token] = header.split(" ");
  if (scheme !== "Bearer" || !token) return null;
  try {
    return jwt.verify(token, config.jwtSecret, { algorithms: ["HS256"] });
  } catch {
    return undefined;
  }
}

// Rejects requests when accounts are unavailable (no database or secret).
function requireDb(req, res, next) {
  if (!config.accountsEnabled || !isConnected()) {
    return res.status(503).json({ error: "Accounts are unavailable right now. Your city still saves in this browser." });
  }
  next();
}

function requireAuth(req, res, next) {
  const payload = readToken(req);
  if (!payload) return res.status(401).json({ error: payload === undefined ? "Your session has expired. Please sign in again." : "Please sign in." });
  req.userId = payload.sub;
  next();
}

module.exports = { signToken, requireDb, requireAuth };
