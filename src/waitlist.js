const { prisma } = require("./db");

// Deliberately conservative: catches real typos without rejecting valid
// addresses. Full RFC validation belongs to the eventual email provider.
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ROLES = new Set(["talent", "client"]);
const MAX_CATEGORIES = 20;
const MAX_NOTE = 140;

async function join(req, res) {
  const { email, role, categories, note } = req.body ?? {};

  if (typeof email !== "string" || !EMAIL.test(email.trim())) {
    return res.status(400).json({ error: "Enter a valid email address." });
  }

  if (role !== undefined && !ROLES.has(role)) {
    return res.status(400).json({ error: "Unknown role." });
  }

  // Accept whatever categories are sent rather than validating against a fixed
  // list — the taxonomy is still an open product decision, and what people
  // actually pick is part of how we settle it.
  const cleanCategories = Array.isArray(categories)
    ? categories
        .filter((c) => typeof c === "string" && c.trim())
        .map((c) => c.trim())
        .slice(0, MAX_CATEGORIES)
    : [];

  const cleanNote =
    typeof note === "string" && note.trim() ? note.trim().slice(0, MAX_NOTE) : undefined;

  if (cleanCategories.length === 0 && !cleanNote) {
    return res
      .status(400)
      .json({ error: "Tell us at least one thing you offer or need." });
  }

  const email_ = email.trim().toLowerCase();
  const role_ = role ?? "talent";

  try {
    const existing = await prisma.waitlistEntry.findUnique({ where: { email: email_ } });

    if (existing) {
      // Someone signing up again usually means they have more to tell us —
      // merge the new categories in rather than throwing the submission away.
      const mergedCategories = [
        ...new Set([...existing.categories, ...cleanCategories]),
      ].slice(0, MAX_CATEGORIES);

      await prisma.waitlistEntry.update({
        where: { email: email_ },
        data: {
          role: role_,
          categories: mergedCategories,
          ...(cleanNote ? { note: cleanNote } : {}),
        },
      });
      // A duplicate is still a success from the visitor's point of view —
      // no reason to tell them whether an address is already on the list.
      return res.status(200).json({ ok: true });
    }

    await prisma.waitlistEntry.create({
      data: {
        email: email_,
        role: role_,
        categories: cleanCategories,
        ...(cleanNote ? { note: cleanNote } : {}),
      },
    });
    return res.status(201).json({ ok: true });
  } catch (err) {
    console.error("waitlist write failed:", err);
    return res.status(500).json({ error: "Could not save your place. Try again shortly." });
  }
}

async function count() {
  return prisma.waitlistEntry.count();
}

module.exports = { join, count };
