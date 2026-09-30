import test from "node:test";
import assert from "node:assert/strict";
import { BundledOfficialScheduleProvider } from "../src/schedule/bundled.js";
import { matchRoundTrips } from "../src/schedule/round-trips.js";

test("Tokyo jets never borrow a return from the next date", async () => {
  const services = await new BundledOfficialScheduleProvider().load("2026-09-29", "2026-10-01");
  const links = matchRoundTrips(services);
  const morning = services.find((s) => s.serviceDate === "2026-09-29" && s.serviceNumber === "1220")!;
  const afternoon = services.find((s) => s.serviceDate === "2026-09-29" && s.serviceNumber === "1230")!;
  const earlyReturn = services.find((s) => s.serviceDate === "2026-09-29" && s.serviceNumber === "2210")!;
  const lateReturn = services.find((s) => s.serviceDate === "2026-09-29" && s.serviceNumber === "2220")!;
  const nextReturn = services.find((s) => s.serviceDate === "2026-09-30" && s.serviceNumber === "2210")!;
  assert.equal(links.get(morning.id)?.partnerServiceId, lateReturn.id);
  assert.equal(links.has(afternoon.id), false);
  assert.equal(links.get(lateReturn.id)?.partnerServiceId, morning.id);
  assert.equal(links.has(earlyReturn.id), false);
  assert.equal(links.has(nextReturn.id), false);
});

test("October 1 afternoon departure is not a fabricated overnight jet round trip", async () => {
  const services = await new BundledOfficialScheduleProvider().load("2026-10-01", "2026-10-02");
  const links = matchRoundTrips(services);
  const afternoon = services.find((s) => s.serviceDate === "2026-10-01" && s.serviceNumber === "1230")!;
  const morning = services.find((s) => s.serviceDate === "2026-10-01" && s.serviceNumber === "1220")!;
  const afternoonReturn = services.find((s) => s.serviceDate === "2026-10-01" && s.serviceNumber === "2220")!;
  assert.equal(links.has(afternoon.id), false);
  assert.equal(links.get(morning.id)?.partnerServiceId, afternoonReturn.id);
  assert.equal(services.some((s) => s.serviceDate === "2026-10-01" && s.shipType === "large"), false);
});

test("Atami is its own origin and the night ship returns on the next date", async () => {
  const services = await new BundledOfficialScheduleProvider().load("2026-09-30", "2026-10-01");
  const links = matchRoundTrips(services);
  const atami = services.find((s) => s.serviceNumber === "1100")!;
  const atamiReturn = services.find((s) => s.serviceNumber === "2110")!;
  const large = services.find((s) => s.serviceDate === "2026-09-30" && s.serviceNumber === "3000")!;
  const largeReturn = services.find((s) => s.serviceDate === "2026-10-01" && s.serviceNumber === "2000");
  assert.equal(links.get(atami.id)?.partnerServiceId, atamiReturn.id);
  assert.equal(largeReturn, undefined);
  assert.equal(links.has(large.id), false);
});
