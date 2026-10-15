import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

process.env.ALLOWED_ORIGINS = "https://desk.example.com";
const { createGuard, readBodyLimited } = await import("../backend/security.mjs");

const guard = createGuard({ port: 5999, csp: "default-src 'self'" }).guard;
const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (!(await guard(req, res, url))) return;
  if (url.pathname === "/big") { try { await readBodyLimited(req, 10); res.end("ok"); } catch (e) { res.writeHead(e.status || 500).end("too big"); } return; }
  res.writeHead(200, { "Content-Type": "application/json" }).end('{"ok":true}');
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => server.close());

test("there is no login: requests without credentials work", async () => {
  assert.equal((await fetch(`${base}/api/anything`)).status, 200);
  assert.equal((await fetch(`${base}/login`, { method: "POST" })).status, 200, "/login is not a special route any more");
});

test("CORS is an allowlist: allowed origin echoed, others get nothing, writes from them are blocked", async () => {
  const allowed = await fetch(`${base}/api/x`, { headers: { Origin: "https://desk.example.com" } });
  assert.equal(allowed.headers.get("access-control-allow-origin"), "https://desk.example.com");
  const own = await fetch(`${base}/api/x`, { headers: { Origin: "http://localhost:5999" } });
  assert.equal(own.headers.get("access-control-allow-origin"), "http://localhost:5999");
  const evil = await fetch(`${base}/api/x`, { headers: { Origin: "https://evil.example" } });
  assert.equal(evil.headers.get("access-control-allow-origin"), null);
  const evilPost = await fetch(`${base}/api/x`, { method: "POST", headers: { Origin: "https://evil.example" } });
  assert.equal(evilPost.status, 403);
});

test("preflight: allowed origin 204, other origin 403, never a wildcard", async () => {
  const ok = await fetch(`${base}/api/x`, { method: "OPTIONS", headers: { Origin: "https://desk.example.com", "Access-Control-Request-Method": "POST" } });
  assert.equal(ok.status, 204);
  assert.notEqual(ok.headers.get("access-control-allow-origin"), "*");
  const bad = await fetch(`${base}/api/x`, { method: "OPTIONS", headers: { Origin: "https://evil.example", "Access-Control-Request-Method": "POST" } });
  assert.equal(bad.status, 403);
});

test("cross-site browser requests from a non-allowed origin are refused even for GET", async () => {
  const r = await fetch(`${base}/api/x`, { headers: { "Sec-Fetch-Site": "cross-site" } });
  assert.equal(r.status, 403);
});

test("hardening headers are set", async () => {
  const r = await fetch(`${base}/api/x`);
  assert.equal(r.headers.get("x-content-type-options"), "nosniff");
  assert.equal(r.headers.get("x-frame-options"), "DENY");
  assert.equal(r.headers.get("content-security-policy"), "default-src 'self'");
});

test("/healthz answers for container health checks", async () => {
  const r = await fetch(`${base}/healthz`);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true });
});

test("request bodies are size-capped", async () => {
  const r = await fetch(`${base}/big`, { method: "POST", body: "x".repeat(1000) });
  assert.equal(r.status, 413);
});
