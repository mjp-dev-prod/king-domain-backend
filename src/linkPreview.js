// A preview of a link a person typed (their live site, a repository, a Figma file), the way a chat app unfurls one: the
// page's title, description and picture, read from its Open Graph tags (ogp.me), with the usual fallbacks.
//
// The server fetches the page on the person's behalf, so this is the classic place for server-side request forgery: a link
// to an internal address would make *our* server read it. So: only http and https, only ports 80 and 443, every address the
// name resolves to is checked against private and loopback ranges, the same check runs again on every redirect, the answer
// is capped in size and time, and only an HTML page is read. A failed preview is never an error for the screen: it says why.
const dns = require("node:dns").promises;
const net = require("node:net");

const MAX_BYTES = 256 * 1024;
const TIMEOUT_MS = 6000;
const MAX_REDIRECTS = 3;
const CACHE_MS = 30 * 60 * 1000;
const CACHE_MAX = 500;

/** A link we won't or can't fetch, with the reason in words the person can read. */
class Refused extends Error {
  constructor(reason) {
    super(reason);
    this.reason = reason;
  }
}

const cache = new Map();

/** True for an address that is not on the public internet: loopback, private, link-local, carrier-grade NAT, unspecified. */
function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
  }
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    if (v === "::" || v === "::1") return true;
    if (v.startsWith("::ffff:")) return isPrivateAddress(v.slice(7));
    return v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe8") || v.startsWith("fe9") || v.startsWith("fea") || v.startsWith("feb");
  }
  return true;
}

const allowPrivate = () => process.env.LINK_PREVIEW_ALLOW_PRIVATE === "true";

/** Throws { reason } unless the URL is one we may fetch. `resolve` is injectable so the guard can be tested without a network. */
async function assertFetchable(url, resolve = (host) => dns.lookup(host, { all: true })) {
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new Refused("That doesn't look like a web address.");
  }
  if (!["http:", "https:"].includes(u.protocol)) throw new Refused("Only web links starting with http:// or https:// can be previewed.");
  if (u.username || u.password) throw new Refused("A link with a name and password in it can't be previewed.");
  const port = u.port || (u.protocol === "https:" ? "443" : "80");
  if (!allowPrivate() && !["80", "443"].includes(port)) throw new Refused("That link uses an unusual port, so it isn't previewed.");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const addresses = net.isIP(host) ? [{ address: host }] : await resolve(host).catch(() => null);
  if (!addresses?.length) throw new Refused("That address can't be found. Check the spelling.");
  if (!allowPrivate() && addresses.some((a) => isPrivateAddress(a.address))) throw new Refused("That link points to a private address, so it isn't previewed.");
  return u;
}

const decode = (s) =>
  String(s ?? "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/\s+/g, " ")
    .trim();

/** Reads the preview fields out of a page's HTML: Open Graph first, then Twitter cards, then the plain title and description. */
function parseHtml(html, baseUrl) {
  const head = html.slice(0, MAX_BYTES);
  const metas = {};
  for (const tag of head.match(/<meta\b[^>]*>/gi) ?? []) {
    const attr = (name) => tag.match(new RegExp(`${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i"));
    const key = (attr("property") ?? attr("name"))?.[2] ?? (attr("property") ?? attr("name"))?.[3];
    const content = attr("content")?.[2] ?? attr("content")?.[3];
    if (key && content != null && metas[key.toLowerCase()] === undefined) metas[key.toLowerCase()] = decode(content);
  }
  const title = metas["og:title"] || metas["twitter:title"] || decode(head.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]);
  const description = metas["og:description"] || metas["twitter:description"] || metas.description || "";
  const absolute = (v) => {
    try {
      return v ? new URL(v, baseUrl).toString() : null;
    } catch {
      return null;
    }
  };
  const image = absolute(metas["og:image"] || metas["og:image:url"] || metas["twitter:image"]);
  const icon = head.match(/<link\b[^>]*rel\s*=\s*["'][^"']*icon[^"']*["'][^>]*>/i)?.[0].match(/href\s*=\s*["']([^"']+)["']/i)?.[1];
  return {
    title: title ? title.slice(0, 160) : null,
    description: description ? description.slice(0, 300) : null,
    image: image && /^https?:/i.test(image) ? image : null,
    siteName: metas["og:site_name"] ? metas["og:site_name"].slice(0, 80) : null,
    favicon: absolute(icon) ?? absolute("/favicon.ico"),
  };
}

/** Reads at most MAX_BYTES of the body, then stops, so a huge or endless answer can't fill memory. */
async function readCapped(res) {
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  while (total < MAX_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  reader.cancel().catch(() => {});
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).subarray(0, MAX_BYTES).toString("utf8");
}

/**
 * The preview for one link. Always resolves to { ok, url, host, ... }: when it can't read the page, `ok` is false and
 * `reason` says why in plain words. `deps.resolve` and `deps.fetchImpl` are for tests.
 */
async function preview(url, deps = {}) {
  const key = String(url).trim();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;

  const fetchImpl = deps.fetchImpl ?? fetch;
  let value;
  try {
    let current = await assertFetchable(key, deps.resolve);
    let res;
    for (let hop = 0; ; hop++) {
      res = await fetchImpl(current.toString(), {
        redirect: "manual",
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { "User-Agent": "KingDomainLinkPreview/1.0 (+link preview for a talent's own submission)", Accept: "text/html,application/xhtml+xml" },
      });
      if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
        if (hop >= MAX_REDIRECTS) throw new Refused("That link redirects too many times.");
        current = await assertFetchable(new URL(res.headers.get("location"), current).toString(), deps.resolve);
        continue;
      }
      break;
    }
    const host = current.hostname.replace(/^www\./, "");
    if (res.status === 404 || res.status === 410) value = { ok: false, url: key, host, status: res.status, reason: "The page wasn't found (404). The link may be wrong or the page was removed." };
    else if (res.status === 401 || res.status === 403) value = { ok: false, url: key, host, status: res.status, reason: "The page asked for a sign-in, so it can't be previewed. The checker may not be able to open it either: make it public or shared by link." };
    else if (res.status >= 400) value = { ok: false, url: key, host, status: res.status, reason: `The site answered with an error (${res.status}).` };
    else if (!/text\/html|application\/xhtml/i.test(res.headers.get("content-type") ?? "")) value = { ok: true, url: key, host, status: res.status, kind: "file", title: null, description: null, image: null, siteName: null, favicon: null, finalUrl: current.toString() };
    else value = { ok: true, url: key, host, status: res.status, kind: "page", finalUrl: current.toString(), ...parseHtml(await readCapped(res), current.toString()) };
  } catch (err) {
    const timedOut = err?.name === "TimeoutError" || err?.name === "AbortError";
    value = { ok: false, url: key, host: safeHost(key), reason: err?.reason ?? (timedOut ? "The site took too long to answer." : "The site couldn't be reached.") };
  }
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(key, { at: Date.now(), value });
  return value;
}

function safeHost(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

const clearCache = () => cache.clear();

module.exports = { preview, parseHtml, assertFetchable, isPrivateAddress, clearCache };
