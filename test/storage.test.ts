import test from "node:test";
import assert from "node:assert/strict";
import { twoHourRunSlot } from "../src/storage/d1.js";

test("normalizes scheduled runs into stable two-hour UTC slots", () => {
  assert.equal(twoHourRunSlot(new Date("2026-09-28T13:59:59Z")), "2026-09-28T12:00:00.000Z");
  assert.equal(twoHourRunSlot(new Date("2026-09-28T14:00:00Z")), "2026-09-28T14:00:00.000Z");
});
