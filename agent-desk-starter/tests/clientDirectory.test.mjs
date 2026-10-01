// tests/clientDirectory.test.mjs — proves the client -> phone number
// resolution the WhatsApp connector now depends on actually works, and
// fails safe (never crashes) for an unknown client.
// Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateClientDirectory } from "../contracts/clientDirectorySchema.mjs";
import { getOwnerPhone } from "../backend/clientDirectory.mjs";
import { clientDirectoryFixture } from "../backend/fixtures/clientDirectory.fixture.mjs";

test("the fixture itself is a valid client directory", () => {
  assert.doesNotThrow(() => validateClientDirectory(clientDirectoryFixture));
});

test("rejects a phone number that isn't E.164", () => {
  assert.throws(() => validateClientDirectory([{ clientId: "x", ownerName: "X", ownerPhone: "0400000000" }]));
  assert.throws(() => validateClientDirectory([{ clientId: "x", ownerName: "X", ownerPhone: "+0400000000" }])); // leading 0 after + is invalid
});

test("accepts a well-formed E.164 number", () => {
  assert.doesNotThrow(() => validateClientDirectory([{ clientId: "x", ownerName: "X", ownerPhone: "+393401234567" }]));
});

test("getOwnerPhone resolves the real demo client (rossi_srl) to its own number, not a placeholder", () => {
  const phone = getOwnerPhone("rossi_srl");
  assert.equal(phone, "+390000000001");
  assert.notEqual(phone, "owner", "this is the exact bug that used to ship — must never regress");
});

test("getOwnerPhone falls back to the old literal for an unknown client, without throwing", () => {
  assert.doesNotThrow(() => getOwnerPhone("some_client_not_on_file"));
  assert.equal(getOwnerPhone("some_client_not_on_file"), "owner");
});
