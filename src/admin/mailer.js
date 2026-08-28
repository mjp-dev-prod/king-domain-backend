const dns = require("node:dns");
const nodemailer = require("nodemailer");

const SMTP_HOST = "smtp.gmail.com";
const SMTP_PORT = 587;
const RESOLVE_TIMEOUT_MS = 5000;

// Gmail SMTP as a stopgap until a real domain exists to verify with a proper
// transactional provider — this delivers to any address today, at the cost
// of Gmail's much lower sending limits (a few hundred/day) and being tied to
// one personal-feeling inbox rather than a branded sender.
//
// Render's containers report an IPv6 network interface but can't actually
// route to Gmail over it. Nodemailer resolves both A and AAAA records for
// the host and then picks ONE AT RANDOM to connect to (see formatDNSValue
// in nodemailer's shared/index.js) rather than reliably preferring IPv4, so
// roughly half of all send attempts hit the unreachable IPv6 address.
//
// Resolving the A record ourselves and connecting to that literal IPv4
// address sidesteps nodemailer's resolver entirely (it does no lookup of
// its own once `host` is already an IP). `tls.servername` keeps SNI/cert
// validation pointed at the real hostname so the TLS handshake still checks
// out. dns.resolve4() has no built-in timeout and can hang indefinitely if
// the container's configured nameserver is itself unreachable — a real risk
// on the same host that has the IPv6 routing problem above — so this races
// it against a timeout and falls through to the hostname (nodemailer's own,
// imperfect resolution) rather than hanging the request forever.
let cachedIPv4 = null;
let cacheExpiresAt = 0;
const IPV4_CACHE_MS = 5 * 60 * 1000;

function resolveSmtpHostIPv4() {
  if (cachedIPv4 && Date.now() < cacheExpiresAt) return Promise.resolve(cachedIPv4);

  return new Promise((resolve, reject) => {
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`dns.resolve4 timed out after ${RESOLVE_TIMEOUT_MS}ms`));
    }, RESOLVE_TIMEOUT_MS);

    dns.resolve4(SMTP_HOST, (err, addresses) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      if (err || !addresses?.length) return reject(err || new Error("No A record found."));
      cachedIPv4 = addresses[0];
      cacheExpiresAt = Date.now() + IPV4_CACHE_MS;
      resolve(cachedIPv4);
    });
  });
}

const configured = Boolean(process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD);

const FROM = process.env.GMAIL_USER
  ? `King Domain <${process.env.GMAIL_USER}>`
  : "King Domain <no-reply@example.com>";

function buildTransporter(host) {
  return nodemailer.createTransport({
    host,
    port: SMTP_PORT,
    secure: false,
    requireTLS: true,
    tls: { servername: SMTP_HOST },
    connectionTimeout: 10000,
    auth: {
      user: process.env.GMAIL_USER,
      pass: process.env.GMAIL_APP_PASSWORD,
    },
  });
}

/**
 * Send an email if Gmail SMTP is configured; otherwise log the link so local
 * dev and any environment without credentials still works — invites and
 * resets fall back to "copy this link yourself" rather than failing.
 */
async function send({ to, subject, html, fallbackContext }) {
  if (!configured) {
    console.log(`[mailer] GMAIL_USER/GMAIL_APP_PASSWORD not set — ${fallbackContext}`);
    return { sent: false };
  }

  let host = SMTP_HOST;
  try {
    host = await resolveSmtpHostIPv4();
  } catch (err) {
    // Resolving ourselves is a best-effort fix for the IPv6 issue — if it
    // fails or times out, fall back to nodemailer's own resolution rather
    // than blocking the request on it.
    console.error("mailer: manual A record resolution failed, falling back:", err.message);
  }

  try {
    await buildTransporter(host).sendMail({ from: FROM, to, subject, html });
    return { sent: true };
  } catch (err) {
    console.error("mailer: send failed:", err);
    return { sent: false, error: err };
  }
}

function sendPasswordReset({ to, resetUrl }) {
  return send({
    to,
    subject: "Reset your King Domain admin password",
    html: `
      <p>Someone requested a password reset for this account.</p>
      <p><a href="${resetUrl}">Reset your password</a></p>
      <p>This link expires in 1 hour. If you didn't request this, you can ignore this email.</p>
    `,
    fallbackContext: `password reset link for ${to}: ${resetUrl}`,
  });
}

function sendInvite({ to, inviteUrl, expiresInHours }) {
  return send({
    to,
    subject: "You've been invited to King Domain admin",
    html: `
      <p>You've been invited to the King Domain admin dashboard.</p>
      <p><a href="${inviteUrl}">Accept the invite</a></p>
      <p>This link expires in ${expiresInHours} hours and can only be used once.</p>
    `,
    fallbackContext: `invite link for ${to}: ${inviteUrl}`,
  });
}

module.exports = { sendPasswordReset, sendInvite };
