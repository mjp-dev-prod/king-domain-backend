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

module.exports = { CATEGORIES, SKILLS, skillByKey, isSkillKey, catalogue };
