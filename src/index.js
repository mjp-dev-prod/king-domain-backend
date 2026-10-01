require("../instrument");
require("dotenv/config");
const Sentry = require("@sentry/node");
const express = require("express");
const { prisma } = require("./db");
const waitlist = require("./waitlist");
const user = require("./user/routes");
const userJobs = require("./user/jobsRoutes");
const admin = require("./admin/routes");
const adminWaitlist = require("./admin/waitlistRoutes");
const adminDecisions = require("./admin/decisionRoutes");
const adminAppReleases = require("./admin/appReleaseRoutes");
const adminProofReview = require("./admin/proofReviewRoutes");
const appRoutes = require("./app/appRoutes");
const { startNotificationScheduler } = require("./admin/notifications");
const mcpAdmin = require("./mcp-admin/mcp-admin.routes");
const paystackWebhook = require("./webhooks/paystackWebhook");

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
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
    // Authorization carries the JWT access token now — auth moved off
    // cookies entirely (Safari/iOS rejected the cross-site session cookie
    // in production; see admin/jwt.js). No credentials/cookie flag needed.
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  }

  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// Mounted BEFORE express.json() — HMAC signature verification needs the
// exact raw request bytes Paystack signed, which express.json() would
// otherwise consume and re-serialize differently. See the router's own
// comment for why a re-serialized JSON.stringify(req.body) silently fails.
app.use("/webhooks/paystack", paystackWebhook.router);

app.use(express.json());

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// Hit every 10 minutes by an external scheduler (cron-job.org): keeps
// Render's free instance from spinning down (it sleeps after 15 idle
// minutes) and touches the database so Supabase never sees a week of
// inactivity and pauses the project. Kept separate from /health so a
// database blip doesn't fail Render's own health check and restart the app.
app.get("/health/db", async (req, res) => {
  const started = Date.now();
  let timer;
  try {
    await Promise.race([
      prisma.$queryRaw`SELECT 1`,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("timed out after 5s")), 5000);
      }),
    ]);
    res.json({ status: "ok", database: "ok", ms: Date.now() - started });
  } catch (err) {
    const cause = err.meta?.driverAdapterError?.cause;
    console.error(
      "health/db: database check failed:",
      err.code ?? "",
      cause ? JSON.stringify(cause) : String(err.message ?? err).replace(/\s+/g, " ").trim(),
    );
    res.status(503).json({ status: "degraded", database: "unreachable" });
  } finally {
    clearTimeout(timer);
  }
});

app.post("/waitlist", waitlist.join);

app.get("/waitlist/count", async (req, res) => {
  res.json({ count: await waitlist.count() });
});

app.use("/users", user.router);
app.use("/jobs", userJobs.router);
app.use("/admin", admin.router);
app.use("/admin/waitlist", adminWaitlist.router);
app.use("/admin/decisions", adminDecisions.router);
app.use("/admin/app-releases", adminAppReleases.router);
app.use("/admin/proof-items", adminProofReview.router);
app.use("/app", appRoutes.router);
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
