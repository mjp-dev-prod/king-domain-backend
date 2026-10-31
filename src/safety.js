// Detection for text people type to each other before a job is awarded (PRD §4.5; decisions D17, D18).
// It FLAGS, it never decides: a job post is held for a person, a message is held with a warning the sender can
// read. Plain patterns on purpose, so a person can read why something was caught.

const PATTERNS = [
  { code: "phone", label: "A phone number", re: /(?:\+?234[\s-]?|\b0)[789](?:[\s-]?\d){9}\b/ },
  { code: "email", label: "An email address", re: /[A-Za-z0-9._%+-]+\s?(?:@|\[at\]|\(at\))\s?[A-Za-z0-9.-]+\s?(?:\.|\[dot\]|\(dot\))\s?[A-Za-z]{2,}/i },
  { code: "link", label: "A link", re: /\b(?:https?:\/\/|www\.)\S+|\b[a-z0-9-]+\.(?:com|ng|co|io|me|link|xyz|app)\b\/?\S*/i },
  { code: "chat_app", label: "An invitation to chat somewhere else", re: /\b(?:whats\s?app|telegram|signal|dm me|text me|call me|reach me on|contact me on)\b/i },
  { code: "outside_payment", label: "Paying or being paid outside King Domain", re: /\b(?:pay (?:me )?(?:outside|directly|offline)|outside (?:the )?(?:app|platform|king domain)|bank transfer to|send (?:me )?(?:the )?money|cash ?app|paypal|crypto|bitcoin|usdt|gift ?card)\b/i },
  { code: "pay_to_apply", label: "Asking the talent to pay", re: /\b(?:registration fee|pay (?:a |the )?(?:fee|deposit) (?:first|before)|processing fee|activation fee|buy (?:the )?(?:software|license|data) first|send (?:₦|n)?\s?\d)/i },
  { code: "meet", label: "An invitation to meet in person", re: /\b(?:meet (?:me|up|in person)|come to (?:my|our) (?:office|place|house)|physical meeting|visit (?:me|us))\b/i },
  { code: "apk", label: "A program to install", re: /\.(?:apk|exe|bat|msi|scr)\b/i },
];

/** The flags in `text`, each with the part that matched. Empty when nothing was caught. */
function detectRisk(text) {
  if (typeof text !== "string" || !text.trim()) return [];
  const found = [];
  for (const p of PATTERNS) {
    const m = text.match(p.re);
    if (m) found.push({ code: p.code, label: p.label, match: m[0].slice(0, 60) });
  }
  return found;
}

/** All the text of a job post that a talent will read, joined for one scan. */
function jobPostText({ title, description, brief, screeningQuestions }) {
  const parts = [title, description];
  for (const v of Object.values(brief ?? {})) {
    if (typeof v === "string") parts.push(v);
    else if (Array.isArray(v)) for (const m of v) if (m?.title) parts.push(m.title);
  }
  for (const q of screeningQuestions ?? []) parts.push(q);
  return parts.filter(Boolean).join("\n");
}

/** Reason codes a team member picks when a held post does not go live. */
const POST_REJECT_REASONS = [
  { code: "contact_details", label: "It asks talents to contact you outside King Domain" },
  { code: "outside_payment", label: "It asks for payment, or offers payment, outside King Domain" },
  { code: "pay_to_apply", label: "It asks talents to pay before work" },
  { code: "vague", label: "The brief is too vague to judge the work against" },
  { code: "not_a_job", label: "It is not a job a talent can do remotely" },
  { code: "unsafe", label: "It could put a talent at risk" },
  { code: "other", label: "Something else (the note says what)" },
];

module.exports = { detectRisk, jobPostText, POST_REJECT_REASONS };
