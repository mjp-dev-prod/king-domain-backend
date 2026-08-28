const nodemailer = require("nodemailer");

// Gmail SMTP as a stopgap until a real domain exists to verify with a proper
// transactional provider — this delivers to any address today, at the cost
// of Gmail's much lower sending limits (a few hundred/day) and being tied to
// one personal-feeling inbox rather than a branded sender.
const transporter =
  process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD
    ? nodemailer.createTransport({
        // 587 + STARTTLS is Google's and nodemailer's own recommended config
        // (port 465's implicit TLS is the legacy path). This also sidesteps
        // an ENETUNREACH seen on Render: nodemailer resolves both A and AAAA
        // records and tries IPv4 first, but if the host's IPv4 route to
        // Gmail is the one that's actually broken, it falls through to an
        // IPv6 address the container can't route — a different port/host
        // pairing avoids depending on that fallback order at all.
        host: "smtp.gmail.com",
        port: 587,
        secure: false,
        requireTLS: true,
        auth: {
          user: process.env.GMAIL_USER,
          pass: process.env.GMAIL_APP_PASSWORD,
        },
      })
    : null;

const FROM = process.env.GMAIL_USER
  ? `King Domain <${process.env.GMAIL_USER}>`
  : "King Domain <no-reply@example.com>";

/**
 * Send an email if Gmail SMTP is configured; otherwise log the link so local
 * dev and any environment without credentials still works — invites and
 * resets fall back to "copy this link yourself" rather than failing.
 */
async function send({ to, subject, html, fallbackContext }) {
  if (!transporter) {
    console.log(`[mailer] GMAIL_USER/GMAIL_APP_PASSWORD not set — ${fallbackContext}`);
    return { sent: false };
  }

  try {
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
