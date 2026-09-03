require("../instrument");
require("dotenv/config");
const Sentry = require("@sentry/node");
const express = require("express");
const cookieParser = require("cookie-parser");
const waitlist = require("./waitlist");
const admin = require("./admin/routes");
const adminWaitlist = require("./admin/waitlistRoutes");
const adminDecisions = require("./admin/decisionRoutes");
const { startNotificationScheduler } = require("./admin/notifications");
const mcpAdmin = require("./mcp-admin/mcp-admin.routes");

const app = express();
const port = process.env.PORT || 4000;

// Render terminates TLS upstream; without this req.ip is the proxy's address,
// which would make the admin rate limiter useless.
app.set("trust proxy", 1);

const allowedOrigins = (process.env.ALLOWED_ORIGINS || "http://localhost:5173")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

// Set CORS directly rather than via the `cors` package — this is a handful of
// headers, and being explicit means the allowlist behaviour is readable.
app.use((req, res, next) => {
  const origin = req.headers.origin;

  if (origin && allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    // The admin app sends its session cookie from a different origin.
    res.setHeader("Access-Control-Allow-Credentials", "true");
  }

  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.use(express.json());
app.use(cookieParser());

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

app.post("/waitlist", waitlist.join);

app.get("/waitlist/count", async (req, res) => {
  res.json({ count: await waitlist.count() });
});

app.use("/admin", admin.router);
app.use("/admin/waitlist", adminWaitlist.router);
app.use("/admin/decisions", adminDecisions.router);
app.use("/api/mcp-admin", mcpAdmin.router);

// Must be registered after all routes and before any other error middleware.
Sentry.setupExpressErrorHandler(app);

// Any unhandled route error should not leak a stack trace to the client.
app.use((err, req, res, _next) => {
  console.error("unhandled error:", err);
  res.status(500).json({ error: "Something went wrong." });
});

app.listen(port, () => {
  console.log(`King Domain backend listening on port ${port}`);
  startNotificationScheduler();
});
