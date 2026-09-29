import test from "node:test";
import assert from "node:assert/strict";
import { dateRangeEnd, twoHourRunSlot } from "../src/storage/d1.js";

test("normalizes even-JST scheduled runs into stable odd-UTC two-hour slots", () => {
  assert.equal(twoHourRunSlot(new Date("2026-09-28T12:59:59Z")), "2026-09-28T11:00:00.000Z");
  assert.equal(twoHourRunSlot(new Date("2026-09-28T13:00:00Z")), "2026-09-28T13:00:00.000Z");
  assert.equal(twoHourRunSlot(new Date("2026-09-29T00:00:00Z")), "2026-09-28T23:00:00.000Z");
});

test("returns an exclusive five-day date boundary without JST to UTC drift", () => {
  assert.equal(dateRangeEnd("2026-09-29", 5), "2026-10-04");
  assert.equal(dateRangeEnd("2026-12-30", 5), "2027-01-04");
});
