require("dotenv/config");
const express = require("express");
const waitlist = require("./waitlist");

const app = express();
const port = process.env.PORT || 4000;

const allowedOrigins = (process.env.ALLOWED_ORIGINS || "http://localhost:5173")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

// Set CORS directly rather than via the `cors` package — this is two headers
// on one route, and being explicit means the allowlist behaviour is readable.
app.use((req, res, next) => {
  const origin = req.headers.origin;

  if (origin && allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  }

  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.use(express.json());

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

app.post("/waitlist", waitlist.join);

app.get("/waitlist/count", async (req, res) => {
  res.json({ count: await waitlist.count() });
});

app.listen(port, () => {
  console.log(`King Domain backend listening on port ${port}`);
});
