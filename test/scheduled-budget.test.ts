import test from "node:test";
import assert from "node:assert/strict";
import { GEMINI_BUDGET, geminiBudgetEnabled } from "../src/worker/scheduled.js";

test("limits Gemini to four services on six-hour UTC slots", () => {
  assert.deepEqual(GEMINI_BUDGET, { intervalHours: 6, servicesPerRun: 4, serviceDelayMs: 15_000 });
  assert.equal(geminiBudgetEnabled(new Date("2026-09-29T00:00:00Z")), true);
  assert.equal(geminiBudgetEnabled(new Date("2026-09-29T02:00:00Z")), false);
  assert.equal(geminiBudgetEnabled(new Date("2026-09-29T06:00:00Z")), true);
});
