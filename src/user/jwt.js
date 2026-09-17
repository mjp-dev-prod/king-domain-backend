// Access/refresh JWT pair for talent/client users — same pattern as the
// admin dashboard's auth (src/admin/jwt.js), applied to a different user
// table. Kept as a separate module rather than sharing admin/jwt.js
// directly: the two token audiences (AdminUser vs. User) should never be
// interchangeable, and a shared module makes that boundary easy to blur
// by accident.
//
// - Access token: short-lived (15 min), signed JWT, self-contained — sent
//   as `Authorization: Bearer <token>` on every request, never touches the
//   DB to verify.
// - Refresh token: long-lived (7 days), opaque random token, only its hash
//   stored (in UserSession) — this is what's actually revocable.
const jwt = require("jsonwebtoken");
const crypto = require("node:crypto");

const ACCESS_TOKEN_TTL = "15m";
const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
const REFRESH_TOKEN_TTL_DAYS = 7;

function secret() {
  const value = process.env.JWT_SECRET;
  if (!value) {
    throw new Error("JWT_SECRET is not set — cannot sign or verify user tokens.");
  }
  return value;
}

function generateAccessToken(user, sessionId) {
  return jwt.sign(
    { sub: user.id, email: user.email, role: user.role, sessionId, type: "user_access" },
    secret(),
    { expiresIn: ACCESS_TOKEN_TTL },
  );
}

/** Throws (JsonWebTokenError / TokenExpiredError) on an invalid or expired token. */
function verifyAccessToken(token) {
  const decoded = jwt.verify(token, secret(), { algorithms: ["HS256"] });
  if (decoded.type !== "user_access") throw new Error("Not a user access token.");
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
