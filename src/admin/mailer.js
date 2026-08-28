const dns = require("node:dns");
const nodemailer = require("nodemailer");

const SMTP_HOST = "smtp.gmail.com";
const SMTP_PORT = 587;

// Gmail SMTP as a stopgap until a real domain exists to verify with a proper
// transactional provider — this delivers to any address today, at the cost
// of Gmail's much lower sending limits (a few hundred/day) and being tied to
// one personal-feeling inbox rather than a branded sender.
//
// Render's containers report an IPv6 network interface but apparently can't
// actually route to Gmail over it. Nodemailer resolves both A and AAAA
// records for the host and then picks ONE AT RANDOM to connect to
// (see formatDNSValue in nodemailer's shared/index.js) — it does not
// consistently prefer IPv4 despite ordering the combined list that way, so
// roughly half of all send attempts hit the unreachable IPv6 address.
// Resolving the A record ourselves and connecting to that literal IPv4
// address sidesteps nodemailer's resolver entirely (it does no lookup of
// its own when `host` is already an IP). `tls.servername` keeps SNI/cert
// validation pointed at the real hostname so the TLS handshake still checks
// out against Gmail's certificate.
let cachedIPv4 = null;
let cacheExpiresAt = 0;
const IPV4_CACHE_MS = 5 * 60 * 1000;

function resolveSmtpHostIPv4() {
  return new Promise((resolve, reject) => {
    if (cachedIPv4 && Date.now() < cacheExpiresAt) return resolve(cachedIPv4);

    dns.resolve4(SMTP_HOST, (err, addresses) => {
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

  try {
    const ipv4Host = await resolveSmtpHostIPv4();
    const transporter = nodemailer.createTransport({
      host: ipv4Host,
      port: SMTP_PORT,
      secure: false,
      requireTLS: true,
      tls: { servername: SMTP_HOST },
      auth: {
        user: process.env.GMAIL_USER,
        pass: process.env.GMAIL_APP_PASSWORD,
      },
    });

    await transporter.sendMail({ from: FROM, to, subject, html });
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
