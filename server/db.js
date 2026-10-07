const mongoose = require("mongoose");
const config = require("./config");

// Same connection setup as Tone Radar: MONGODB_URI without a database name, MONGODB_DB appended.
function buildUri() {
  const base = config.mongoUri.replace(/\/+$/, "");
  const [hostPart, query = ""] = base.split("?");
  const params = new URLSearchParams(query);
  if (!params.has("retryWrites")) params.set("retryWrites", "true");
  if (!params.has("w")) params.set("w", "majority");
  return `${hostPart}/${config.mongoDb}?${params}`;
}

let status = config.mongoUri ? "connecting" : "disabled";

async function connect() {
  if (!config.mongoUri) return mongoose.connection;
  mongoose.set("strictQuery", true);
  mongoose.connection.on("connected", () => {
    status = "connected";
    console.log(`MongoDB connected (database "${config.mongoDb}")`);
  });
  mongoose.connection.on("disconnected", () => {
    if (status === "connected") console.warn("MongoDB disconnected");
    status = "disconnected";
  });
  try {
    await mongoose.connect(buildUri(), { serverSelectionTimeoutMS: 10000 });
  } catch (err) {
    status = "error";
    console.warn(`MongoDB connection failed: ${err.message}`);
    console.warn("Running without accounts: cities can still be saved in the browser.");
  }
  return mongoose.connection;
}

const isConnected = () => mongoose.connection.readyState === 1;
const dbStatus = () => (isConnected() ? "connected" : status);

module.exports = { connect, connection: mongoose.connection, isConnected, dbStatus };
