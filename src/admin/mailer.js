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
function sendDeliveryAwaitingReview({ to, jobTitle, reviewDueAt, autoRelease, version = 1 }) {
  return send({
    to,
    subject:
      version > 1
        ? `Revised work delivered on "${jobTitle}" (version ${version}): please review`
        : `Work delivered on "${jobTitle}": please review`,
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

/** The talent asked for more time; silence for 48 h grants it. */
function sendExtensionRequested({ to, jobTitle, days, reason, proposedDeliverBy, answerDueAt }) {
  return send({
    to,
    subject: `Extension requested on "${jobTitle}"`,
    html: `
      <p>The talent working on <strong>${escapeHtml(jobTitle)}</strong> has asked for ${days} more day${days === 1 ? "" : "s"}, which would move the delivery date to <strong>${formatWAT(proposedDeliverBy)}</strong>.</p>
      <p>Their reason: "${escapeHtml(reason)}"</p>
      <p>Please grant or decline it in the app by <strong>${formatWAT(answerDueAt)}</strong>. If you don't answer by then, it is granted automatically.</p>
    `,
    fallbackContext: `extension requested for ${to}: ${jobTitle}`,
  });
}

const EXTENSION_OUTCOMES = {
  granted: (date) => `The client granted your extension. The new delivery date is <strong>${formatWAT(date)}</strong>.`,
  autoGranted: (date) =>
    `The client didn't answer within 48 hours, so your extension was granted automatically. The new delivery date is <strong>${formatWAT(date)}</strong>.`,
  declined: (date) => `The client declined your extension. The delivery date stays <strong>${formatWAT(date)}</strong>.`,
};

function sendExtensionAnswered({ to, jobTitle, outcome, deliverByAt }) {
  return send({
    to,
    subject: outcome === "declined" ? `Extension declined on "${jobTitle}"` : `Extension granted on "${jobTitle}"`,
    html: `<p><strong>${escapeHtml(jobTitle)}</strong>: ${EXTENSION_OUTCOMES[outcome](deliverByAt)}</p>`,
    fallbackContext: `extension ${outcome} for ${to}: ${jobTitle}`,
  });
}

function sendExtensionAutoGrantedToClient({ to, jobTitle, deliverByAt }) {
  return send({
    to,
    subject: `Extension granted on "${jobTitle}"`,
    html: `<p>You didn't answer the talent's extension request on <strong>${escapeHtml(jobTitle)}</strong> within 48 hours, so it was granted automatically, as agreed. The new delivery date is <strong>${formatWAT(deliverByAt)}</strong>.</p>`,
    fallbackContext: `extension auto-granted (client) for ${to}: ${jobTitle}`,
  });
}

function sendChangesRequested({ to, jobTitle, round, maxRounds, reason, resubmitDueAt }) {
  return send({
    to,
    subject: `Changes requested on "${jobTitle}" (round ${round} of ${maxRounds})`,
    html: `
      <p>The client asked for changes to <strong>${escapeHtml(jobTitle)}</strong>.</p>
      <p>What they asked for: "${escapeHtml(reason)}"</p>
      <p>Please resubmit in the app by <strong>${formatWAT(resubmitDueAt)}</strong>. If you don't resubmit by then, the job goes to a King Domain admin.</p>
      ${round === maxRounds ? "<p>This is the last round: if the client is still not satisfied after it, an admin will decide.</p>" : ""}
    `,
    fallbackContext: `changes requested (round ${round}) for ${to}: ${jobTitle}`,
  });
}

const ESCALATION_REASONS = {
  client_rejected_after_final_round: "The client was still not satisfied after the last round of changes",
  talent_missed_change_deadline: "The requested changes weren't resubmitted in time",
};

function sendEscalated({ to, jobTitle, reason }) {
  return send({
    to,
    subject: `"${jobTitle}" has gone to a King Domain admin`,
    html: `
      <p>${ESCALATION_REASONS[reason]} on <strong>${escapeHtml(jobTitle)}</strong>, so the job has gone to a King Domain admin.</p>
      <p>The admin will look at every version of the work and the change requests, and decide. Nothing is paid out or refunded until then.</p>
    `,
    fallbackContext: `escalated (${reason}) for ${to}: ${jobTitle}`,
  });
}

function sendEscalationToAdmin({ to, jobTitle, contractId, reason, note }) {
  return send({
    to,
    subject: `Dispute needs an admin: "${jobTitle}"`,
    html: `
      <p><strong>${escapeHtml(jobTitle)}</strong> (contract ${escapeHtml(contractId)}) was escalated: ${ESCALATION_REASONS[reason]}.</p>
      ${note ? `<p>The client wrote: "${escapeHtml(note)}"</p>` : ""}
      <p>There is no dispute screen yet (stage 3). The contract is parked as <code>disputed</code>; nothing moves until it is resolved.</p>
    `,
    fallbackContext: `escalation (${reason}) to admin ${to}: ${contractId}`,
  });
}

/** Stage 2 only records this; cancel-for-refund arrives with stage 3. */
function sendDeliveryOverdueToClient({ to, jobTitle, deliverByAt }) {
  return send({
    to,
    subject: `"${jobTitle}" is 3 days past its delivery date`,
    html: `
      <p>The delivery date for <strong>${escapeHtml(jobTitle)}</strong> was <strong>${formatWAT(deliverByAt)}</strong>. It has now passed by 3 days with nothing delivered and no extension agreed, and we've recorded this on the job.</p>
      <p>The option to cancel for a refund of the job budget isn't available in the app yet.</p>
    `,
    fallbackContext: `delivery overdue (client) for ${to}: ${jobTitle}`,
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
  sendExtensionRequested,
  sendExtensionAnswered,
  sendExtensionAutoGrantedToClient,
  sendChangesRequested,
  sendEscalated,
  sendEscalationToAdmin,
  sendDeliveryOverdueToClient,
};
