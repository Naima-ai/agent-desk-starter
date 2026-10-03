// backend/security.mjs — the one gate every HTTP request passes first.
// (Same file lives in teamsystem-firm-mock/backend/security.mjs — the two
// services are separate packages, so it is duplicated on purpose.)
//
// What it does, and what it does NOT do:
//  * CORS is an allowlist, not "*". Only origins in ALLOWED_ORIGINS (plus this
//    service's own localhost origins) may read responses or send writes.
//    CORS alone only protects against other WEBSITES in a user's browser — it
//    does nothing against someone who can reach the port directly, so:
//  * The server binds to 127.0.0.1 by default (HOST=0.0.0.0 to expose it).
//  * Set DESK_ACCESS_TOKEN and every request must carry it: browsers log in
//    once at /login (HttpOnly, SameSite=Strict cookie), services send
//    "Authorization: Bearer <token>". Unset = open (local dev only; warned).
//  * Cross-site requests (Sec-Fetch-Site: cross-site) from a non-allowed
//    origin are refused even for GET, because /api/run-demo is a GET with
//    side effects.
//  * Standard hardening headers + a CSP that only allows this app's own CDNs.
import { timingSafeEqual, createHmac } from "node:crypto";

const trim = (s) => s.trim();
const sameBytes = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};

export function listenHost() { return process.env.HOST || "127.0.0.1"; }

/** Header to attach to service-to-service calls (Agent Desk <-> TeamSystem mock). */
export function serviceAuthHeaders() {
  return process.env.DESK_ACCESS_TOKEN ? { Authorization: `Bearer ${process.env.DESK_ACCESS_TOKEN}` } : {};
}

const LOGIN_PAGE = (msg = "") => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sign in</title>
<style>body{font-family:Arial,sans-serif;background:#F6F8FC;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;color:#07234F}
form{background:#fff;border:1px solid #D5E2F5;border-radius:12px;padding:28px;width:320px}h1{font-size:18px;margin:0 0 14px}
input{width:100%;box-sizing:border-box;padding:9px;border:1px solid #D5E2F5;border-radius:6px;margin-bottom:12px}
button{width:100%;padding:10px;background:#0A63E0;color:#fff;border:0;border-radius:6px;font-weight:700;cursor:pointer}.e{color:#C0473C;font-size:13px;margin-bottom:10px}</style></head>
<body><form method="post" action="/login"><h1>Sign in</h1>${msg ? `<div class="e">${msg}</div>` : ""}<input type="password" name="token" placeholder="Access token" autofocus required><button>Sign in</button></form></body></html>`;

export function createGuard({ port, csp, publicPaths = [] }) {
  const accessToken = process.env.DESK_ACCESS_TOKEN || "";
  const allowed = new Set([
    `http://localhost:${port}`, `http://127.0.0.1:${port}`,
    ...(process.env.ALLOWED_ORIGINS || "").split(",").map(trim).filter(Boolean),
  ]);
  const session = accessToken ? createHmac("sha256", accessToken).update("desk-session-v1").digest("hex") : "";
  const attempts = new Map(); // ip -> { n, resetAt }

  if (!accessToken) console.warn("[security] DESK_ACCESS_TOKEN is not set — API is unauthenticated. Fine for local dev; set it before exposing this service.");
  if (listenHost() !== "127.0.0.1" && !accessToken) console.warn(`[security] HOST=${listenHost()} with no DESK_ACCESS_TOKEN — anyone who can reach this port has full access.`);

  function setHeaders(res) {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "same-origin"); // NOT no-referrer: browsers then send "Origin: null" on same-origin form posts
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    if (csp) res.setHeader("Content-Security-Policy", csp);
  }

  const cookieValue = (req) => {
    const m = /(?:^|;\s*)desk_session=([a-f0-9]+)/.exec(req.headers.cookie || "");
    return m ? m[1] : "";
  };
  const bearer = (req) => String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const authorized = (req) => !accessToken || (bearer(req) && sameBytes(bearer(req), accessToken)) || (cookieValue(req) && sameBytes(cookieValue(req), session));

  function deny(res, status, error) {
    res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify({ error }));
  }

  async function readForm(req) {
    const chunks = []; let size = 0;
    for await (const c of req) { size += c.length; if (size > 4096) return null; chunks.push(c); }
    return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
  }

  /** Returns true if the request may continue; false if the guard already answered. */
  async function guard(req, res, url) {
    setHeaders(res);
    // Liveness probe for Docker/orchestrators: no data, no auth.
    if (url.pathname === "/healthz" && (req.method === "GET" || req.method === "HEAD")) {
      res.writeHead(200, { "Content-Type": "application/json" }).end('{"ok":true}');
      return false;
    }
    const origin = req.headers.origin;
    const originOk = origin ? allowed.has(origin) : false;

    if (origin) {
      if (originOk) {
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Access-Control-Allow-Credentials", "true");
        res.setHeader("Vary", "Origin");
      }
      if (req.method === "OPTIONS") {
        if (!originOk) { deny(res, 403, "origin not allowed"); return false; }
        res.writeHead(204, {
          "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
          "Access-Control-Max-Age": "600",
        }).end();
        return false;
      }
      if (!originOk && req.method !== "GET" && req.method !== "HEAD") { deny(res, 403, "origin not allowed"); return false; }
    }
    if (req.headers["sec-fetch-site"] === "cross-site" && !originOk) { deny(res, 403, "cross-site request refused"); return false; }

    if (!accessToken) return true;
    // Machine-to-machine callbacks (e.g. an inbound-email webhook) that authenticate themselves with their own secret.
    if (publicPaths.includes(url.pathname) && req.method === "POST") return true;

    if (url.pathname === "/login" && req.method === "POST") {
      const ip = req.socket.remoteAddress || "?";
      const now = Date.now();
      const a = attempts.get(ip) && attempts.get(ip).resetAt > now ? attempts.get(ip) : { n: 0, resetAt: now + 10 * 60 * 1000 };
      if (a.n >= 10) { res.writeHead(429, { "Content-Type": "text/html" }).end(LOGIN_PAGE("Too many attempts — try again in a few minutes.")); return false; }
      const form = await readForm(req);
      if (form && sameBytes(form.get("token") || "", accessToken)) {
        attempts.delete(ip);
        const secure = process.env.COOKIE_SECURE === "true" || req.headers["x-forwarded-proto"] === "https";
        res.writeHead(303, { Location: "/", "Set-Cookie": `desk_session=${session}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${secure ? "; Secure" : ""}` }).end();
      } else {
        a.n += 1; attempts.set(ip, a);
        res.writeHead(401, { "Content-Type": "text/html" }).end(LOGIN_PAGE("Wrong token."));
      }
      return false;
    }
    if (url.pathname === "/logout" && req.method === "POST") {
      res.writeHead(303, { Location: "/login", "Set-Cookie": "desk_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0" }).end();
      return false;
    }
    if (authorized(req)) return true;
    if (url.pathname.startsWith("/api/") || url.pathname === "/events") { deny(res, 401, "authentication required"); return false; }
    res.writeHead(401, { "Content-Type": "text/html" }).end(LOGIN_PAGE());
    return false;
  }

  return { guard, allowedOrigins: [...allowed], authEnabled: Boolean(accessToken) };
}

/** Read a request body with a hard size cap (default 25 MB) instead of buffering forever. */
export function readBodyLimited(req, limit = Number(process.env.MAX_BODY_BYTES) || 25 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0; let tooBig = false;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) { if (!tooBig) { tooBig = true; chunks.length = 0; const e = new Error("request body too large"); e.status = 413; reject(e); } return; } // keep draining so the 413 can be delivered
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
