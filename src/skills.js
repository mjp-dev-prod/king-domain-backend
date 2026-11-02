// The one list of skills King Domain verifies and hires for (PRD §4.2, §4.6, decision D25).
// Category labels are the strings already stored on ProofItem.category and Job.category,
// so rows written before skills existed still resolve. The app reads this through GET /skills.

const CATEGORIES = [
  { key: "tech", label: "Software & tech" },
  { key: "design", label: "Design & creative" },
  { key: "writing", label: "Writing & content" },
  { key: "marketing", label: "Marketing & growth" },
  { key: "tutoring", label: "Tutoring & training" },
  { key: "video", label: "Video & media" },
];

// kind: files (any document or image), image, video, text (typed in the app), link (a URL).
const SKILLS = [
  {
    key: "graphic-design",
    label: "Graphic design",
    category: "design",
    open: true,
    startProof: [
      { key: "concepts", label: "Two or three concept directions", kind: "files", min: 2, max: 3 },
      { key: "moodboard", label: "A moodboard", kind: "image", min: 1, max: 1 },
    ],
  },
  {
    key: "short-form-video",
    label: "Short-form video editing",
    category: "video",
    open: true,
    startProof: [
      { key: "roughCut", label: "Rough cut of the first piece", kind: "video", min: 1, max: 1 },
      { key: "timeline", label: "Screenshot of the project timeline", kind: "image", min: 1, max: 1 },
    ],
  },
  {
    key: "social-media",
    label: "Social media management",
    category: "marketing",
    open: true,
    startProof: [
      { key: "calendar", label: "The month's content calendar", kind: "files", min: 1, max: 1 },
      { key: "firstWeek", label: "The first week's posts, drafted", kind: "files", min: 1, max: 14 },
    ],
  },
  {
    key: "writing",
    label: "Writing",
    category: "writing",
    open: true,
    startProof: [
      { key: "outline", label: "Outline", kind: "text", min: 1, max: 1 },
      { key: "firstSection", label: "The first section", kind: "files", min: 1, max: 1 },
    ],
  },
  {
    key: "web-development",
    label: "Web development",
    category: "tech",
    open: true,
    startProof: [
      { key: "structure", label: "Wireframes or a sitemap", kind: "files", min: 1, max: 5 },
      { key: "repository", label: "Repository with the first commits, or a staging link", kind: "link", min: 1, max: 1 },
    ],
  },
];

const byKey = new Map(SKILLS.map((s) => [s.key, s]));

function skillByKey(key) {
  return byKey.get(key) ?? null;
}

function isSkillKey(key) {
  return typeof key === "string" && byKey.has(key);
}

function catalogue() {
  return { categories: CATEGORIES, skills: SKILLS };
}

// "Show how it was made" (decision 2026-11-02, replaces "working files" and "drafts"): at least one piece needs one of these.
// The wording is per skill because a writer has no layers and a developer has no timeline.
const HOW_MADE = {
  "graphic-design": {
    prompt: "Show that you made it. Any one of these, for at least one piece.",
    options: [
      "A screenshot of the design open in your app (Canva, Photoshop, Figma, Illustrator)",
      "The design file itself, or a link to it in Figma or Canva",
      "A photo of your early sketches or notes",
      "An earlier version, before the final changes",
    ],
  },
  "short-form-video": {
    prompt: "Show that you made it. Any one of these, for at least one piece.",
    options: [
      "A screenshot of the edit open in your app, with your clips on the timeline (CapCut, InShot, Premiere, DaVinci)",
      "A short screen recording scrolling through the project",
      "A rough cut from before the final edit",
      "The project file",
    ],
  },
  "social-media": {
    prompt: "Show that you did it. Any one of these, for at least one piece.",
    options: [
      "Screenshots of the content plan or calendar you used (Google Sheets, Notion, Trello)",
      "Screenshots of the account's insights for the period",
      "The first drafts of posts, before they were published",
    ],
  },
  writing: {
    prompt: "Show that you wrote it. Any one of these, for at least one piece.",
    options: [
      "A screenshot of the document's version history (in Google Docs: File, then Version history)",
      "An outline, notes or an earlier draft",
      "A link to the document, shared so we can open it",
    ],
  },
  "web-development": {
    prompt: "Show that you built it. Any one of these, for at least one piece.",
    options: [
      "A link to the project on GitHub, GitLab or similar, so the history can be read",
      "A screenshot of the code open in your editor",
      "A short screen recording of the site running on your machine",
    ],
  },
};
const FALLBACK_HOW_MADE = { prompt: "Show how it was made. Any one of these, for at least one piece.", options: ["A screenshot of the work open in the tool you used", "An earlier version or your notes", "A link to the project, if it has a history"] };
for (const s of SKILLS) s.howMade = HOW_MADE[s.key] ?? FALLBACK_HOW_MADE;

module.exports = { CATEGORIES, SKILLS, skillByKey, isSkillKey, catalogue };
