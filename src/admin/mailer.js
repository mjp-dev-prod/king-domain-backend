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

/** Sprint 4 (king-domain-mobile): the 6-digit code VerifyEmailScreen collects. */
function sendVerificationCode({ to, code }) {
  return send({
    to,
    subject: `${code} is your King Domain verification code`,
    html: `
      <p>Your verification code is:</p>
      <p style="font-size:28px;font-weight:700;letter-spacing:4px;">${code}</p>
      <p>This code expires in 10 minutes. If you didn't request this, you can ignore this email.</p>
    `,
    fallbackContext: `verification code for ${to}: ${code}`,
  });
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** A reviewer approved a talent's proof — they can now apply in that category. */
function sendProofVerified({ to, title, category }) {
  return send({
    to,
    subject: `You're verified in ${category} on King Domain`,
    html: `
      <p>Your proof of work <strong>${escapeHtml(title)}</strong> was reviewed and accepted.</p>
      <p>You're now <strong>Verified in ${escapeHtml(category)}</strong>, so you can apply to ${escapeHtml(category)} jobs in the app.</p>
    `,
    fallbackContext: `proof verified notice for ${to}: ${title}`,
  });
}

/** A reviewer turned a proof down — tell the talent why and what to do next. */
function sendProofRejected({ to, title, category, reason }) {
  return send({
    to,
    subject: `Your ${category} proof needs another look`,
    html: `
      <p>Your proof of work <strong>${escapeHtml(title)}</strong> (${escapeHtml(category)}) wasn't accepted.</p>
      <p><strong>Reviewer's note:</strong> ${escapeHtml(reason)}</p>
      <p>It has been removed from your profile. Upload a new sample from the Profile tab and it will be reviewed again.</p>
    `,
    fallbackContext: `proof rejected notice for ${to}: ${title} — ${reason}`,
  });
}

/** Dates in emails are shown in Nigerian time, the audience's own clock. */
function formatWAT(date) {
  return new Date(date).toLocaleString("en-NG", {
    timeZone: "Africa/Lagos",
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** The client awarded a job but didn't pay within 24 hours. */
function sendAwardCancelledToClient({ to, jobTitle }) {
  return send({
    to,
    subject: `Your award on "${jobTitle}" was cancelled`,
    html: `
      <p>You selected someone for <strong>${escapeHtml(jobTitle)}</strong> but the job wasn't paid for within 24 hours, so the award has been cancelled.</p>
      <p>The job is open again and every applicant is back under consideration. Nothing was charged. You can award it again from the app whenever you're ready to pay.</p>
    `,
    fallbackContext: `award cancelled (client) for ${to}: ${jobTitle}`,
  });
}

/** Tell the talent their award fell through, without blaming anyone. */
function sendAwardCancelledToTalent({ to, jobTitle }) {
  return send({
    to,
    subject: `"${jobTitle}": the client didn't pay in time`,
    html: `
      <p>You were selected for <strong>${escapeHtml(jobTitle)}</strong>, but the client didn't pay within 24 hours, so the award was cancelled and the job is open again.</p>
      <p>You're back in the running for it, and you can keep applying to other jobs. You didn't lose anything: work only starts once a job is paid for.</p>
    `,
    fallbackContext: `award cancelled (talent) for ${to}: ${jobTitle}`,
  });
}

/** Work was delivered: say exactly how long the client has and what happens next. */
function sendDeliveryAwaitingReview({ to, jobTitle, reviewDueAt, autoRelease }) {
  return send({
    to,
    subject: `Work delivered on "${jobTitle}": please review`,
    html: autoRelease
      ? `
      <p>The talent has delivered <strong>${escapeHtml(jobTitle)}</strong>.</p>
      <p>Please review it in the app by <strong>${formatWAT(reviewDueAt)}</strong>. If you don't respond by then, payment is released to the talent automatically.</p>
    `
      : `
      <p>The talent has delivered <strong>${escapeHtml(jobTitle)}</strong>. Please review it in the app and approve it to release payment.</p>
    `,
    fallbackContext: `delivery awaiting review for ${to}: ${jobTitle}`,
  });
}

function sendPaymentAutoReleasedToTalent({ to, jobTitle }) {
  return send({
    to,
    subject: `You've been paid for "${jobTitle}"`,
    html: `
      <p>The client didn't respond within the review period, so payment for <strong>${escapeHtml(jobTitle)}</strong> was released to your bank account automatically.</p>
      <p>Transfers can take a little while to show in your account.</p>
    `,
    fallbackContext: `auto-release paid (talent) for ${to}: ${jobTitle}`,
  });
}

function sendPaymentAutoReleasedToClient({ to, jobTitle }) {
  return send({
    to,
    subject: `Payment released for "${jobTitle}"`,
    html: `
      <p>You didn't review the delivery of <strong>${escapeHtml(jobTitle)}</strong> within the review period, so payment was released to the talent automatically, as agreed when the job was awarded.</p>
    `,
    fallbackContext: `auto-release paid (client) for ${to}: ${jobTitle}`,
  });
}

/** App users (talent/client): the code ResetPasswordScreen collects. */
function sendUserPasswordResetCode({ to, code, expiresInMinutes }) {
  return send({
    to,
    subject: `${code} is your King Domain password reset code`,
    html: `
      <p>Use this code to reset your King Domain password:</p>
      <p style="font-size:28px;font-weight:700;letter-spacing:4px;">${code}</p>
      <p>It expires in ${expiresInMinutes} minutes. If you didn't ask to reset your password, ignore this email — your password stays the same.</p>
    `,
    fallbackContext: `password reset code for ${to}: ${code}`,
  });
}

function sendUserPasswordChanged({ to }) {
  return send({
    to,
    subject: "Your King Domain password was changed",
    html: `
      <p>Your King Domain password was just changed, and every device signed in to your account has been signed out.</p>
      <p>If this wasn't you, reset your password again from the app straight away.</p>
    `,
    fallbackContext: `password changed notice for ${to}`,
  });
}

module.exports = {
  sendPasswordReset,
  sendInvite,
  sendNewDecisionNotice,
  sendCommentDigest,
  sendVerificationCode,
  sendUserPasswordResetCode,
  sendUserPasswordChanged,
  sendProofVerified,
  sendProofRejected,
  sendAwardCancelledToClient,
  sendAwardCancelledToTalent,
  sendDeliveryAwaitingReview,
  sendPaymentAutoReleasedToTalent,
  sendPaymentAutoReleasedToClient,
};
