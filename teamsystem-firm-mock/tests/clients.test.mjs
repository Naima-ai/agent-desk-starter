import test from "node:test";
import assert from "node:assert/strict";
import { clients } from "../backend/data/clients.mjs";
import { isValidPiva } from "../backend/adminActions.mjs";
import { toRawJsonFeed, toCorruptRawJsonFeed } from "../backend/rawFeeds.mjs";

test("the client book has 20 clients with unique ids and unique Partita IVA", () => {
  assert.equal(clients.length >= 20, true);
  const ids = clients.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length);
  const pivas = clients.map((c) => c.piva).filter(Boolean);
  assert.equal(new Set(pivas).size, pivas.length);
});

test("every seeded client's own Partita IVA passes the real check-digit rule", () => {
  for (const c of clients) assert.ok(isValidPiva(c.piva), `${c.name}: ${c.piva}`);
});

test("every client declares what it demonstrates", () => {
  for (const c of clients) assert.ok(c.edgeCase && c.edgeCase.length > 20, `${c.name} has no edgeCase`);
});

test("the FMT-01 client serves a truncated feed that cannot be parsed; every other client's feed parses", () => {
  const broken = clients.find((c) => c.id === "barbieri_feed_corrotto");
  assert.throws(() => JSON.parse(toCorruptRawJsonFeed(broken)), SyntaxError);
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(toRawJsonFeed(broken))), "the complete feed would have been fine");
  for (const c of clients.filter((x) => x.sourceFormat === "json" && !x.corruptFeed)) {
    assert.doesNotThrow(() => JSON.parse(JSON.stringify(toRawJsonFeed(c))), c.name);
  }
});
