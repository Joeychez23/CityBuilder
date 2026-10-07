const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env"), quiet: true });

const config = {
  // API_PORT wins so a PORT meant for the Vite dev server isn't picked up here.
  port: Number(process.env.API_PORT || process.env.PORT) || 5070,
  isProduction: process.env.NODE_ENV === "production",
  mongoUri: process.env.MONGODB_URI || "",
  mongoDb: process.env.MONGODB_DB || "gridlock_city",
  jwtSecret: process.env.JWT_SECRET || "",
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || "7d",
};

// Accounts need both a database and a signing secret; without them the game still runs
// and saves cities in the browser only.
config.accountsEnabled = Boolean(config.mongoUri && config.jwtSecret);

module.exports = config;
