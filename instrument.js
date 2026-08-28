// Must be imported before anything else in the entry point — see
// https://docs.sentry.io/platforms/javascript/guides/node/
const Sentry = require("@sentry/node");

if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV || "development",
  });
}
