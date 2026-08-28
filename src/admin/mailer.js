const { Resend } = require("resend");

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
const FROM = process.env.RESEND_FROM || "King Domain <onboarding@resend.dev>";

/**
 * Send an email if Resend is configured; otherwise log the link so local
 * dev and any environment without RESEND_API_KEY still works — invites and
 * resets fall back to "copy this link yourself" rather than failing.
 */
async function send({ to, subject, html, fallbackContext }) {
  if (!resend) {
    console.log(`[mailer] RESEND_API_KEY not set — ${fallbackContext}`);
    return { sent: false };
  }

  try {
    await resend.emails.send({ from: FROM, to, subject, html });
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
