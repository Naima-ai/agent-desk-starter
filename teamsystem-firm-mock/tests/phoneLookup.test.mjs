// tests/phoneLookup.test.mjs — inbound WhatsApp is matched to a client by phone number.
import test from "node:test";
import assert from "node:assert/strict";
import { clients, getClientByPhone } from "../backend/data/clients.mjs";

test("getClientByPhone matches regardless of formatting, and never matches a client with no phone", () => {
  const c = clients[0];
  const saved = c.phone;
  c.phone = "+39 333 123 4567";
  try {
    assert.equal(getClientByPhone("+393331234567")?.id, c.id);
    assert.equal(getClientByPhone("393331234567")?.id, c.id, "Meta sends digits without the +");
    assert.equal(getClientByPhone("+390000000000"), undefined);
    assert.equal(getClientByPhone(""), undefined);
  } finally {
    c.phone = saved;
  }
});
