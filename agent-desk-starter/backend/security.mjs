// backend/security.mjs — the one gate every HTTP request passes first.
// (Same file lives in teamsystem-firm-mock/backend/security.mjs — the two
// services are separate packages, so it is duplicated on purpose.)
//
// There is no login. What protects the services instead:
//  * They bind to 127.0.0.1 by default, so only this computer can reach them
//    (HOST=0.0.0.0 to expose them; do that only on a network you trust, or
//    behind a reverse proxy that authenticates).
//  * CORS is an allowlist, not "*". Only origins in ALLOWED_ORIGINS (plus this
//    service's own localhost origins) may read responses or send writes, so a
//    random website open in your browser cannot drive the API.
//  * Cross-site requests (Sec-Fetch-Site: cross-site) from a non-allowed
//    origin are refused even for GET, because /api/run-demo is a GET with
//    side effects.
//  * Standard hardening headers + a CSP that only allows this app's own files.
export function listenHost() { return process.env.HOST || "127.0.0.1"; }

export function createGuard({ port, csp }) {
  const allowed = new Set([
    `http://localhost:${port}`, `http://127.0.0.1:${port}`,
    ...(process.env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean),
  ]);

  if (listenHost() !== "127.0.0.1") {
    console.warn(`[security] HOST=${listenHost()} — this service is reachable from other machines and has no login. Only do this on a trusted network.`);
  }

  function setHeaders(res) {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "same-origin"); // NOT no-referrer: browsers then send "Origin: null" on same-origin form posts
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    if (csp) res.setHeader("Content-Security-Policy", csp);
  }

  function deny(res, status, error) {
    res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify({ error }));
  }

  /** Returns true if the request may continue; false if the guard already answered. */
  async function guard(req, res, url) {
    setHeaders(res);
    // Liveness probe for Docker/orchestrators: no data.
    if (url.pathname === "/healthz" && (req.method === "GET" || req.method === "HEAD")) {
      res.writeHead(200, { "Content-Type": "application/json" }).end('{"ok":true}');
      return false;
    }

    const origin = req.headers.origin;
    const originOk = origin ? allowed.has(origin) : false;

    if (origin) {
      if (originOk) {
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Vary", "Origin");
      }
      if (req.method === "OPTIONS") {
        if (!originOk) { deny(res, 403, "origin not allowed"); return false; }
        res.writeHead(204, {
          "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
          "Access-Control-Max-Age": "600",
        }).end();
        return false;
      }
      if (!originOk && req.method !== "GET" && req.method !== "HEAD") { deny(res, 403, "origin not allowed"); return false; }
    }
    if (req.headers["sec-fetch-site"] === "cross-site" && !originOk) { deny(res, 403, "cross-site request refused"); return false; }
    return true;
  }

  return { guard, allowedOrigins: [...allowed] };
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
