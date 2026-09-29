import test from "node:test";
import assert from "node:assert/strict";
import { buildServiceForecastSeries } from "../src/forecast/service-series.js";
import { MARINE_MODELS, WEATHER_MODELS, type MultiModelSources } from "../src/forecast/multi-model.js";
import type { ServiceInput } from "../src/types.js";

const service: ServiceInput = {
  serviceId: "series-test", voyageNumber: "1100", shipType: "jet", direction: "to_oshima", counterpartTerminal: "熱海",
  scheduledDepartureJst: "2026-09-30T09:00:00+09:00", scheduledArrivalJst: "2026-09-30T10:00:00+09:00"
};
const timestampMs = Date.parse("2026-09-30T09:00:00+09:00");

test("builds route aggregates with audited units unchanged", () => {
  const sources = {
    weather: [{ model: WEATHER_MODELS[2], rows: [
      { locationId: "atami_offshore", timestampMs, values: { wind_speed_10m: 8, wind_gusts_10m: 11 } },
      { locationId: "sagami_north", timestampMs, values: { wind_speed_10m: 10, wind_gusts_10m: 14 } }
    ] }],
    marine: [{ model: MARINE_MODELS[1], rows: [
      { locationId: "atami_offshore", timestampMs, values: { wave_height: 1.2, wave_period: 6, swell_wave_height: 0.7 } },
      { locationId: "sagami_north", timestampMs, values: { wave_height: 1.8, wave_period: 8, swell_wave_height: 1.1 } }
    ] }], failures: []
  } as MultiModelSources;
  const result = buildServiceForecastSeries(service, sources);
  assert.equal(result.points.find((item) => item.variable === "wind_speed_10m")?.values[0]?.value, 10);
  assert.equal(result.points.find((item) => item.variable === "wave_height")?.values[0]?.value, 1.8);
  assert.equal(result.points.find((item) => item.variable === "wave_period")?.values[0]?.value, 7);
  assert.equal(result.points.find((item) => item.variable === "wind_speed_10m")?.unit, "m/s");
  assert.equal(result.points.find((item) => item.variable === "wave_height")?.unit, "m");
});
