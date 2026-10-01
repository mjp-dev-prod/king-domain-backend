// Stage 2: the delivery date. The client sets days when posting; the date
// is fixed when the contract is funded (decision clarification, 2026-10-01).
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const h = require("./helpers");
const { prisma } = h;
const { confirmFunding } = require("../src/contractFunding");

let ctx;
before(async () => {
  ctx = await h.fixtures();
});
after(async () => {
  await prisma.job.deleteMany({ where: { title: { startsWith: h.TITLE_PREFIX } } });
  await prisma.$disconnect();
});

describe("delivery date", () => {
  it("funding fixes deliverByAt = fundedAt + the job's delivery days", async () => {
    const s = await h.seedAward(ctx, { job: { deliveryDays: 5 }, contract: { payByAt: h.future() } });
    const r = await confirmFunding({ reference: `kd_${s.c.id}_aaaaaaaa`, amountKobo: 110000, source: "suite" });
    assert.equal(r.outcome, "funded");
    const c = await prisma.contract.findUnique({ where: { id: s.c.id } });
    assert.equal(c.deliverByAt.getTime() - c.fundedAt.getTime(), 5 * h.DAY_MS);
  });

  it("a job posted before delivery dates existed gets no delivery date", async () => {
    const s = await h.seedAward(ctx, { contract: { payByAt: h.future() } });
    await confirmFunding({ reference: `kd_${s.c.id}_bbbbbbbb`, amountKobo: 110000, source: "suite" });
    assert.equal((await prisma.contract.findUnique({ where: { id: s.c.id } })).deliverByAt, null);
  });
});
