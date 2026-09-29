import test from "node:test";
import assert from "node:assert/strict";
import { buildJudgmentContext } from "../src/forecast/judgment-context.js";
import type { HourlyPoint, ServiceInput } from "../src/types.js";

const service: ServiceInput = { serviceId: "fixture", voyageNumber: "1230", shipType: "jet", direction: "to_oshima", counterpartTerminal: "東京", scheduledDepartureJst: "2026-09-29T14:00:00+09:00", scheduledArrivalJst: "2026-09-29T15:45:00+09:00" };
function row(locationId: string, time: string, values: Record<string, number>): HourlyPoint { return { locationId, timestampMs: Date.parse(time), values }; }
const weatherValues = (wind: number) => ({ wind_speed_10m: wind, wind_direction_10m: 225, wind_gusts_10m: wind + 3, precipitation: 1, pressure_msl: 1000 });
const marineValues = (wave: number) => ({ wave_height: wave, wave_direction: 210, wave_period: 8, wind_wave_height: wave - .2, wind_wave_direction: 220, wind_wave_period: 6, swell_wave_height: .8, swell_wave_direction: 190, swell_wave_period: 10 });

test("builds unit-preserving, time-aware official criteria context", () => {
  const weather = [row("tokyo_port", "2026-09-29T05:00:00Z", weatherValues(16)), row("sagami_central", "2026-09-29T02:00:00Z", weatherValues(10)), row("sagami_central", "2026-09-29T05:00:00Z", weatherValues(18.5)), row("oshima_north_okata", "2026-09-29T07:00:00Z", weatherValues(17))];
  const marine = [row("tokyo_port", "2026-09-29T05:00:00Z", marineValues(1.2)), row("sagami_central", "2026-09-29T05:00:00Z", marineValues(3.2)), row("oshima_north_okata", "2026-09-29T07:00:00Z", marineValues(1.1))];
  const context = buildJudgmentContext(service, { comparison: { mean: .4 } }, { weather: [{ model: { id: "jma_msm", label: "JMA MSM", url: "https://api.open-meteo.com/v1/jma" }, rows: weather }], marine: [{ model: { id: "ecmwf_wam", label: "ECMWF WAM" }, rows: marine }], failures: [] }, null, new Date("2026-09-29T00:00:00Z"));
  assert.equal(context.forecasts.weather[0]?.unit.wind_speed_10m, "m/s");
  assert.equal(context.forecasts.marine[0]?.unit.wave_height, "m");
  assert.equal(context.officialCriteria.find((item) => item.criterion === "jet_route_wind")?.status, "reached");
  assert.equal(context.officialCriteria.find((item) => item.criterion === "jet_route_wave")?.threshold, 3);
  assert.equal(context.dataQuality.visibility, "unavailable");
});
