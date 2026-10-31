// The naira per dollar rate, for showing amounts "about" in the person's display currency (D37).
//
// There is no live rates provider yet (a "partner for dollar payouts" is an open item), so the rate is set by hand in
// FX_NGN_PER_USD with the date it was set in FX_AS_OF. With no rate, nothing is converted and the app shows only the
// job's own currency: a made-up rate would be a fake substitute for a real one.

function currentRate(now = new Date()) {
  const rate = Number(process.env.FX_NGN_PER_USD);
  if (!Number.isFinite(rate) || rate <= 0) return { ngnPerUsd: null, asOf: null, source: null };
  const asOf = process.env.FX_AS_OF ? new Date(process.env.FX_AS_OF) : null;
  return { ngnPerUsd: rate, asOf: asOf && !Number.isNaN(asOf.getTime()) ? asOf.toISOString() : null, source: "set by the team", ageDays: asOf && !Number.isNaN(asOf.getTime()) ? Math.floor((now - asOf) / 86_400_000) : null };
}

module.exports = { currentRate };
