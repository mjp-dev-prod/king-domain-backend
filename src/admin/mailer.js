// Brevo's HTTP API, not SMTP — Render's free tier blocks all outbound
// traffic to SMTP ports (25, 465, 587), confirmed via their own changelog:
// https://render.com/changelog/free-web-services-will-no-longer-allow-outbound-traffic-to-smtp-ports
// No amount of client configuration works around that; it's a network-level
// block. An HTTPS API sidesteps it entirely — the same port 443 every other
// outbound call this app makes (Supabase, Sentry) already uses successfully.
//
// Brevo specifically because, unlike Resend, its free tier can send to any
// recipient without first verifying a sending domain — genuinely necessary
// here since there's no domain to verify yet.
const BREVO_ENDPOINT = "https://api.brevo.com/v3/smtp/email";

const configured = Boolean(process.env.BREVO_API_KEY && process.env.BREVO_SENDER_EMAIL);

const SENDER = {
  name: "King Domain",
  email: process.env.BREVO_SENDER_EMAIL,
};

/**
 * Send an email if Brevo is configured; otherwise log the link so local dev
 * and any environment without credentials still works — invites and resets
 * fall back to "copy this link yourself" rather than failing.
 */
async function send({ to, subject, html, fallbackContext }) {
  if (!configured) {
    console.log(`[mailer] BREVO_API_KEY/BREVO_SENDER_EMAIL not set — ${fallbackContext}`);
    return { sent: false };
  }

  try {
    const response = await fetch(BREVO_ENDPOINT, {
      method: "POST",
      headers: {
        "api-key": process.env.BREVO_API_KEY,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        sender: SENDER,
        to: [{ email: to }],
        subject,
        htmlContent: html,
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Brevo API responded ${response.status}: ${body}`);
    }

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

function sendNewDecisionNotice({ to, decision }) {
  const base = process.env.ADMIN_APP_URL || "http://localhost:5180";
  const url = `${base}/decisions/${decision.id}`;
  return send({
    to,
    subject: `New decision: ${decision.title}`,
    html: `
      <p>A new decision has been posted for review.</p>
      <p><strong>${decision.title}</strong></p>
      <p>${decision.description}</p>
      <p><a href="${url}">View and respond</a></p>
    `,
    fallbackContext: `new decision notice for ${to}: ${url}`,
  });
}

function sendCommentDigest({ to, decisionTitle, decisionId, commentCount }) {
  const base = process.env.ADMIN_APP_URL || "http://localhost:5180";
  const url = `${base}/decisions/${decisionId}`;
  const plural = commentCount === 1 ? "comment" : "comments";
  return send({
    to,
    subject: `${commentCount} new ${plural} on "${decisionTitle}"`,
    html: `
      <p>${commentCount} new ${plural} on <strong>${decisionTitle}</strong> since you last checked — you haven't cast a stance on this one yet.</p>
      <p><a href="${url}">View the discussion</a></p>
    `,
    fallbackContext: `comment digest for ${to}: ${url}`,
  });
}

module.exports = { sendPasswordReset, sendInvite, sendNewDecisionNotice, sendCommentDigest };
