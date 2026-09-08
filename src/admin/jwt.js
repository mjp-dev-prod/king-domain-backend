// Access/refresh JWT pair for the admin dashboard, replacing the cookie
// session — see AdminSession's schema comment for why. Pattern ported from
// pendu-admin's proven implementation (pendu---backend/src/utils/jwt.js).
//
// - Access token: short-lived (15 min), signed JWT, self-contained — sent
//   as `Authorization: Bearer <token>` on every request, never touches the
//   DB to verify.
// - Refresh token: long-lived (7 days, matching the old session TTL),
//   opaque random token, only its hash stored (in AdminSession) — this is
//   what's actually revocable. Sent once at login/refresh, kept in the
//   frontend's localStorage, never in a cookie.
const jwt = require("jsonwebtoken");
const crypto = require("node:crypto");

const ACCESS_TOKEN_TTL = "15m";
const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
const REFRESH_TOKEN_TTL_DAYS = 7;

function secret() {
  const value = process.env.JWT_SECRET;
  if (!value) {
    throw new Error("JWT_SECRET is not set — cannot sign or verify admin tokens.");
  }
  return value;
}

function generateAccessToken(user, sessionId) {
  return jwt.sign(
    { sub: user.id, email: user.email, role: user.role, sessionId, type: "access" },
    secret(),
    { expiresIn: ACCESS_TOKEN_TTL },
  );
}

/** Throws (JsonWebTokenError / TokenExpiredError) on an invalid or expired token. */
function verifyAccessToken(token) {
  const decoded = jwt.verify(token, secret(), { algorithms: ["HS256"] });
  if (decoded.type !== "access") throw new Error("Not an access token.");
  return decoded;
}

/** 32 random bytes, url-safe. Only the hash of this is ever stored. */
function generateRefreshToken() {
  return crypto.randomBytes(32).toString("base64url");
}

function hashRefreshToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

module.exports = {
  ACCESS_TOKEN_TTL_SECONDS,
  REFRESH_TOKEN_TTL_DAYS,
  generateAccessToken,
  verifyAccessToken,
  generateRefreshToken,
  hashRefreshToken,
};
