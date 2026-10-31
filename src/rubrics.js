// What reviewers score a skill submission against (PRD §4.3, decision D5). One rubric per launch skill.
//
// Every rubric here is a DRAFT: the video lines come from docs/research/proof-verification-2026-10-30.md §7.5,
// the others were drafted without a practitioner. Each needs a working session with someone who practises
// the skill before it is relied on (PRD open item), so the API says so and the screens show it.

const SCALE = [
  { score: 1, label: "Below the standard" },
  { score: 2, label: "Nearly there" },
  { score: 3, label: "Meets the standard" },
  { score: 4, label: "Strong" },
];

const line = (key, label, looksLike) => ({ key, label, looksLike });

const RUBRICS = {
  "short-form-video": {
    draft: true,
    lines: [
      line("structure", "Structure and story", "A clear beginning, middle and end; every cut earns its place."),
      line("pacing", "Pacing and rhythm", "Cuts land on the beat of the content; no dead air or rushed beats."),
      line("sound", "Sound", "Dialogue is clear, music sits under it, levels are even."),
      line("picture", "Picture", "Framing, colour and exposure are consistent from shot to shot."),
      line("text", "Captions and titles", "Readable, accurate, well timed, and in the safe area for phones."),
      line("brief", "Fit to the brief", "Does what the brief asked, in the format asked for."),
      line("export", "Export quality", "Right resolution, ratio and file size for where it will be posted."),
    ],
  },
  "graphic-design": {
    draft: true,
    lines: [
      line("concept", "Concept", "A clear idea behind the design, not only decoration."),
      line("layout", "Layout and hierarchy", "The eye knows where to go first; spacing and alignment are deliberate."),
      line("type", "Typography", "Typefaces suit the message; sizes, weights and line spacing are controlled."),
      line("colour", "Colour", "A limited, purposeful palette with enough contrast to read."),
      line("craft", "Craft and files", "Clean, production-ready files (layers named, assets sized, nothing rasterised by mistake)."),
      line("brief", "Fit to the brief", "Solves what the client asked for, for the audience asked for."),
    ],
  },
  "social-media": {
    draft: true,
    lines: [
      line("strategy", "Content plan", "A plan with a reason: audience, themes and a mix of formats."),
      line("copy", "Copy and voice", "Clear, on-brand captions with a call to action where needed."),
      line("visual", "Visual consistency", "Posts look like one brand; templates are reusable."),
      line("cadence", "Cadence", "A realistic schedule the person could keep every week."),
      line("engagement", "Engagement thinking", "Hooks, replies and community habits, not only posting."),
      line("brief", "Fit to the brief", "Matches the business and goals described."),
    ],
  },
  writing: {
    draft: true,
    lines: [
      line("structure", "Clarity and structure", "The point is clear; the order helps the reader."),
      line("voice", "Voice and tone", "Suits the audience and the client's brand."),
      line("accuracy", "Accuracy and research", "Claims are right and sourced where they should be."),
      line("style", "Grammar and style", "Clean, concise, no distracting errors."),
      line("audience", "Audience fit", "Written for the person who will read it."),
      line("brief", "Fit to the brief", "Delivers the length, format and angle asked for."),
    ],
  },
  "web-development": {
    draft: true,
    lines: [
      line("structure", "Structure and semantics", "Sensible markup and page structure; navigation makes sense."),
      line("visual", "Visual implementation", "Matches the design closely; spacing and type are consistent."),
      line("responsive", "Responsiveness", "Works on a phone, a tablet and a laptop."),
      line("code", "Code quality", "Readable, organised, with a repository history that shows how it was built."),
      line("function", "Works as intended", "Forms, links and interactions do what they should."),
      line("access", "Performance and accessibility", "Loads fast; usable with a keyboard and readable contrast."),
    ],
  },
};

function rubricFor(skillKey) {
  return RUBRICS[skillKey] ?? null;
}

module.exports = { SCALE, RUBRICS, rubricFor };
