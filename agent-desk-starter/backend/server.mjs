// backend/server.mjs — zero-framework HTTP + Server-Sent Events.
// Serves the frontend, streams bus events, exposes compile + run endpoints.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";
import { subscribe, history } from "./bus.mjs";
import { compile } from "./compiler.mjs";
import { runVatFilingPath } from "./scenario/vatFilingPath.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const pub = join(here, "..", "frontend");
const PORT = process.env.PORT || 5173;
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === "/events") {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    for (const e of history()) res.write(`data: ${JSON.stringify(e)}\n\n`);
    const off = subscribe((e) => res.write(`data: ${JSON.stringify(e)}\n\n`));
    req.on("close", off);
    return;
  }
  if (url.pathname === "/api/run-demo" || url.pathname === "/api/run-golden-path") { runVatFilingPath(); res.writeHead(202).end('{"started":true}'); return; }
  if (url.pathname.startsWith("/api/compile/")) {
    const seat = url.pathname.split("/").pop();
    try { const { manifest, skill } = await compile(seat); res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ manifest, skill })); }
    catch (e) { res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: String(e) })); }
    return;
  }

  // static
  let p = url.pathname === "/" ? "/index.html" : url.pathname;
  try {
    const body = await readFile(join(pub, p));
    res.writeHead(200, { "Content-Type": MIME[extname(p)] || "application/octet-stream" }).end(body);
  } catch { res.writeHead(404).end("Not found"); }
});

server.listen(PORT, () => console.log(`Agent Desk starter on http://localhost:${PORT}`));
