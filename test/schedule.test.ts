import test from "node:test";
import assert from "node:assert/strict";
import { BundledOfficialScheduleProvider } from "../src/schedule/bundled.js";

test("loads verified September Oshima services with JST timestamps", async () => {
  const rows = await new BundledOfficialScheduleProvider().load("2026-09-29", "2026-09-30");
  assert.equal(rows.length, 13);
  const overnight = rows.find((row) => row.serviceNumber === "3000");
  assert.equal(overnight?.scheduledDepartureJst, "2026-09-30T22:00:00+09:00");
  assert.equal(overnight?.scheduledArrivalJst, "2026-10-01T06:00:00+09:00");
  assert.ok(rows.every((row) => row.origin === "大島" || row.destination === "大島"));
});

test("applies official large-ship exclusion dates", async () => {
  const rows = await new BundledOfficialScheduleProvider().load("2026-10-13", "2026-10-14");
  assert.equal(rows.some((row) => row.serviceDate === "2026-10-13" && row.serviceNumber === "3000"), false);
  assert.equal(rows.some((row) => row.serviceDate === "2026-10-14" && row.serviceNumber === "2000"), false);
  assert.equal(rows.filter((row) => row.serviceNumber === "1230").length, 2);
});
