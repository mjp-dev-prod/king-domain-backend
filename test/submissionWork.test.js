// "What you sent": the owner can open everything they submitted, with links that expire, plain reasons for each
// requirement and advice where the work looks thin; and a link they typed can be previewed without our server
// ever being turned against our own network.
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const crypto = require("node:crypto");
const h = require("./helpers");
const lp = require("../src/linkPreview");
const { prisma } = h;

describe("link previews: the address guard", () => {
  const resolveTo = (...addresses) => async () => addresses.map((address) => ({ address }));

  it("refuses private, loopback, link-local and carrier-grade addresses, in both IP versions", () => {
    for (const ip of ["127.0.0.1", "10.0.0.5", "172.16.4.4", "172.31.255.1", "192.168.1.9", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "::1", "::", "fd12::1", "fe80::1", "::ffff:10.0.0.1"]) {
      assert.equal(lp.isPrivateAddress(ip), true, ip);
    }
    for (const ip of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "100.63.255.1", "2606:4700:4700::1111"]) assert.equal(lp.isPrivateAddress(ip), false, ip);
  });

  it("only web links on the normal ports, with no password in them", async () => {
    await assert.rejects(lp.assertFetchable("ftp://example.com/x", resolveTo("8.8.8.8")), /Only web links/);
    await assert.rejects(lp.assertFetchable("file:///etc/passwd"), /Only web links/);
    await assert.rejects(lp.assertFetchable("http://user:pw@example.com/", resolveTo("8.8.8.8")), /name and password/);
    await assert.rejects(lp.assertFetchable("http://example.com:6379/", resolveTo("8.8.8.8")), /unusual port/);
    await assert.rejects(lp.assertFetchable("not a url"), /doesn't look like/);
    assert.ok(await lp.assertFetchable("https://example.com/page", resolveTo("93.184.216.34")));
  });

  it("refuses a name that resolves to a private address, even if only one of several does", async () => {
    await assert.rejects(lp.assertFetchable("https://sneaky.example/", resolveTo("8.8.8.8", "10.0.0.7")), /private address/);
    await assert.rejects(lp.assertFetchable("http://169.254.169.254/latest/meta-data/"), /private address/);
    await assert.rejects(lp.assertFetchable("http://[::1]/"), /private address/);
    await assert.rejects(lp.assertFetchable("https://nowhere.example/", async () => { throw new Error("ENOTFOUND"); }), /can't be found/);
  });

  it("checks every redirect again, so a public page can't bounce us to an internal one", async () => {
    lp.clearCache();
    const calls = [];
    const fetchImpl = async (u) => {
      calls.push(u);
      return new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data/" } });
    };
    const r = await lp.preview("https://public.example/redirect", { resolve: resolveTo("93.184.216.34"), fetchImpl });
    assert.equal(r.ok, false);
    assert.match(r.reason, /private address/);
    assert.equal(calls.length, 1, "the internal address was never requested");
  });
});

describe("link previews: reading a page", () => {
  const html = `<!doctype html><html><head>
    <title>Fallback title</title>
    <meta property="og:title" content="Rentipede &amp; Co: find a room">
    <meta property="og:description" content="Rent without the stress.">
    <meta property="og:image" content="/img/cover.png">
    <meta property="og:site_name" content="Rentipede">
    <link rel="icon" href="/fav.png"></head><body>hello</body></html>`;

  it("reads Open Graph first, resolves relative pictures, and decodes the text", () => {
    const r = lp.parseHtml(html, "https://rentipede.example/home");
    assert.equal(r.title, "Rentipede & Co: find a room");
    assert.equal(r.description, "Rent without the stress.");
    assert.equal(r.image, "https://rentipede.example/img/cover.png");
    assert.equal(r.siteName, "Rentipede");
    assert.equal(r.favicon, "https://rentipede.example/fav.png");
  });

  it("falls back to the plain title and description, and never invents a picture", () => {
    const r = lp.parseHtml(`<title> Plain page </title><meta name="description" content="A page.">`, "https://x.example/");
    assert.equal(r.title, "Plain page");
    assert.equal(r.description, "A page.");
    assert.equal(r.image, null);
    assert.equal(r.favicon, "https://x.example/favicon.ico");
  });

  it("says why when a page can't be read: not found, signed-in only, an error, too slow", async () => {
    lp.clearCache();
    const resolve = async () => [{ address: "93.184.216.34" }];
    const answer = (status) => async () => new Response("", { status, headers: { "content-type": "text/html" } });
    assert.match((await lp.preview("https://a.example/404", { resolve, fetchImpl: answer(404) })).reason, /wasn't found/);
    assert.match((await lp.preview("https://a.example/403", { resolve, fetchImpl: answer(403) })).reason, /asked for a sign-in/);
    assert.match((await lp.preview("https://a.example/500", { resolve, fetchImpl: answer(500) })).reason, /error \(500\)/);
    const slow = await lp.preview("https://a.example/slow", { resolve, fetchImpl: async () => { throw Object.assign(new Error("x"), { name: "TimeoutError" }); } });
    assert.match(slow.reason, /too long/);
    const file = await lp.preview("https://a.example/file.zip", { resolve, fetchImpl: async () => new Response("x", { status: 200, headers: { "content-type": "application/zip" } }) });
    assert.equal(file.ok, true);
    assert.equal(file.kind, "file");
  });

  it("is remembered for a while, so a screen that reopens doesn't hit the site again", async () => {
    lp.clearCache();
    let hits = 0;
    const fetchImpl = async () => {
      hits++;
      return new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
    };
    const resolve = async () => [{ address: "93.184.216.34" }];
    await lp.preview("https://cache.example/", { resolve, fetchImpl });
    await lp.preview("https://cache.example/", { resolve, fetchImpl });
    assert.equal(hits, 1);
  });

  it("reads a real page over HTTP, and stops reading a huge one", async () => {
    lp.clearCache();
    process.env.LINK_PREVIEW_ALLOW_PRIVATE = "true";
    const big = http.createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.write(`<title>Big page</title>`);
      const chunk = "x".repeat(64 * 1024);
      let sent = 0;
      const pump = () => {
        while (sent < 50 * 1024 * 1024) {
          sent += chunk.length;
          if (!res.write(chunk)) return res.once("drain", pump);
        }
        res.end();
      };
      pump();
      req.on("close", () => res.destroy());
    });
    await new Promise((r) => big.listen(0, "127.0.0.1", r));
    try {
      const started = Date.now();
      const r = await lp.preview(`http://127.0.0.1:${big.address().port}/`);
      assert.equal(r.ok, true);
      assert.equal(r.title, "Big page");
      assert.ok(Date.now() - started < 4000, "stopped after the cap instead of downloading 50 MB");
    } finally {
      big.close();
      delete process.env.LINK_PREVIEW_ALLOW_PRIVATE;
      lp.clearCache();
    }
  });
});

describe("what you sent, over HTTP", () => {
  let ctx, server, r2, fakeProvider, ta, tb, tc;

  before(async () => {
    ctx = await h.fixtures();
    fakeProvider = await h.serveFakeProvider(h.fakeProvider());
    r2 = await h.serveFakeR2();
    server = await h.startServer({ port: 4721, paystackUrl: fakeProvider.url, autoRelease: false, env: { R2_ACCOUNT_ID: "test", R2_ACCESS_KEY_ID: "test", R2_SECRET_ACCESS_KEY: "test", R2_PRIVATE_BUCKET: "private-test", R2_ENDPOINT: r2.url } });
    [ta, tb, tc] = await Promise.all([h.tokenFor(ctx.talentA), h.tokenFor(ctx.talentB), h.tokenFor(ctx.client)]);
    await prisma.skillSubmission.deleteMany({ where: { userId: { in: [ctx.talentA.id, ctx.talentB.id] } } });
  });
  after(async () => {
    server?.stop();
    r2?.server.close();
    fakeProvider?.server.close();
    await prisma.skillSubmission.deleteMany({ where: { userId: { in: [ctx.talentA.id, ctx.talentB.id] } } });
    await prisma.$disconnect();
  });

  const api = (tok, p) => h.call(server.base, tok, "GET", p);
  const file = (submissionId, pieceId, role, name, contentType) => ({ submissionId, pieceId, role, name, contentType, sizeBytes: 2048, objectKey: `submissions/${crypto.randomUUID()}-${name}`, status: "ready" });

  async function sent({ thin = false } = {}) {
    const s = await prisma.skillSubmission.create({ data: { userId: ctx.talentA.id, skillKey: "web-development", status: "authenticity", declaredOwnWork: true, aiUsed: true, aiNote: "Used it for boilerplate", submittedAt: new Date() } });
    const p1 = await prisma.submissionPiece.create({ data: { submissionId: s.id, position: 1, title: "Pendu", brief: thin ? "A site." : "A calling app for students. The client wanted group calls and a clean landing page.", role: "Developer", madeOn: "March 2026", liveLink: "https://pendu.example", processLink: "https://github.com/me/pendu" } });
    const p2 = await prisma.submissionPiece.create({ data: { submissionId: s.id, position: 2, title: "Rentipede", brief: "A room-finding site with search and saved rooms for tenants.", role: "Developer", madeOn: "May 2026", liveLink: "https://rentipede.example" } });
    await prisma.submissionFile.createMany({
      data: [file(s.id, p1.id, "output", "home.png", "image/png"), file(s.id, p1.id, "working", "code.png", "image/png"), file(s.id, null, "walkthrough", "walk.mp4", "video/mp4"), { ...file(s.id, p2.id, "output", "pending.mp4", "video/mp4"), status: "pending" }],
    });
    return s;
  }

  it("shows the owner every piece with its files as links that expire, grouped by what they are", async () => {
    const s = await sent();
    const r = await api(ta, `/users/me/submissions/${s.id}/work`);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const w = r.json.work;
    assert.equal(w.skillLabel, "Web development");
    assert.equal(w.pieces.length, 2);
    const [a, b] = w.pieces;
    assert.equal(a.title, "Pendu");
    assert.equal(a.brief.startsWith("A calling app"), true, "the brief is given in full, not cut short");
    assert.equal(a.finished[0].kind, "image");
    assert.match(a.finished[0].url, /X-Amz-Expires=3600/, "a short-lived signed link");
    assert.equal(a.howMade[0].name, "code.png");
    assert.equal(a.processLink, "https://github.com/me/pendu");
    assert.equal(b.finished.length, 0, "a file that never finished uploading isn't listed as sent");
    assert.equal(w.walkthrough[0].kind, "video");
    assert.ok(w.walkthrough[0].url);
    assert.deepEqual(w.declaration, { ownWork: true, aiUsed: true, aiNote: "Used it for boilerplate" });
    assert.ok(w.howMade.options.some((o) => /GitHub/.test(o)), "says what was asked for this skill");
  });

  it("explains every requirement and whether it is met", async () => {
    const s = await sent();
    const w = (await api(ta, `/users/me/submissions/${s.id}/work`)).json.work;
    const keys = w.requirements.map((x) => x.key);
    assert.ok(["pieces", "details", "outputs", "howMade", "walkthrough", "declaration"].every((k) => keys.includes(k)));
    for (const req of w.requirements) assert.ok(req.why && req.why.length > 20, `${req.key} says why it is asked for`);
    assert.equal(w.requirements.find((x) => x.key === "howMade").done, true);
  });

  it("gives gentle advice, never blocking, on a thin brief and a link-only piece", async () => {
    const s = await sent({ thin: true });
    const w = (await api(ta, `/users/me/submissions/${s.id}/work`)).json.work;
    const [a, b] = w.pieces;
    assert.ok(a.checks.some((c) => c.key === "brief" && c.state === "advice"), "a one-line brief");
    assert.ok(b.checks.some((c) => c.key === "finished" && c.state === "advice" && /goes down/.test(c.detail)), "a live link and no file");
    assert.ok(b.checks.some((c) => c.key === "howMade" && c.state === "ok" && /Another piece/.test(c.detail)), "one piece's evidence is enough");
    assert.equal(w.summary.verdict, "complete_with_advice");
  });

  it("is for the owner alone", async () => {
    const s = await sent();
    assert.equal((await api(tb, `/users/me/submissions/${s.id}/work`)).status, 404, "another talent can't even tell it exists");
    assert.equal((await api(tc, `/users/me/submissions/${s.id}/work`)).status, 403, "clients have no submissions");
    assert.equal((await h.call(server.base, null, "GET", `/users/me/submissions/${s.id}/work`)).status, 401);
  });

  it("the preview route is for talent, rate limited, and needs a link", async () => {
    assert.equal((await api(ta, "/users/link-preview")).status, 400);
    assert.equal((await api(tc, "/users/link-preview?url=https://example.com")).status, 403);
    const r = await api(ta, "/users/link-preview?url=http://169.254.169.254/latest/meta-data/");
    assert.equal(r.status, 200);
    assert.equal(r.json.preview.ok, false);
    assert.match(r.json.preview.reason, /private address/);
  });
});
