// Stage 2 over real HTTP: the real server against the test database.
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const h = require("./helpers");
const { prisma } = h;

let ctx, fake, server, ct, tt, tb;
before(async () => {
  ctx = await h.fixtures();
  fake = await h.serveFakeProvider(h.fakeProvider());
  server = await h.startServer({ port: 4612, paystackUrl: fake.url, autoRelease: false });
  [ct, tt, tb] = await Promise.all([h.tokenFor(ctx.client), h.tokenFor(ctx.talentA), h.tokenFor(ctx.talentB)]);
});
after(async () => {
  server?.stop();
  fake?.server.close();
  await prisma.job.deleteMany({ where: { title: { startsWith: h.TITLE_PREFIX } } });
  await prisma.$disconnect();
});

const post = (tok, p, body) => h.call(server.base, tok, "POST", p, body);
const jobBody = (deliveryDays) => ({ title: `${h.TITLE_PREFIX}routes`, category: h.CATEGORY, description: "suite", budget: 1000, deliveryDays });

describe("POST /jobs delivery days", () => {
  it("is required, a whole number from 1 to 60", async () => {
    for (const bad of [undefined, 0, 61, 2.5, "x"]) {
      const r = await post(ct, "/jobs", jobBody(bad));
      assert.equal(r.status, 400, `deliveryDays=${bad}`);
    }
    const ok = await post(ct, "/jobs", jobBody(7));
    assert.equal(ok.status, 201);
    assert.equal(ok.json.job.deliveryDays, 7);
  });
});
