import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { buildFeatures, validateFeatures } from "../src/ml/build-features.js";
import { MODEL_FEATURE_NAMES, NUMERIC_FEATURE_NAMES } from "../src/ml/feature-names.js";
import type { HourlyPoint, NormalizedForecasts, ServiceInput } from "../src/types.js";

const HOUR = 3_600_000;
const departure = Date.parse("2026-09-29T08:30:00+09:00");
const route = ["tokyo_port", "tokyo_bay_mouth", "uraga_channel", "sagami_north", "sagami_central", "oshima_north_okata", "oshima_west_motomachi"];
function rows(kind: "weather" | "marine"): HourlyPoint[] {
  const result: HourlyPoint[] = [];
  for (let h = -7; h <= 3; h++) for (const locationId of route) {
    const common: Record<string, number> = kind === "weather"
      ? { wind_speed_10m: 5 + h / 10, wind_direction_10m: h % 2 ? 359 : 1, wind_gusts_10m: 8, pressure_msl: 1012, precipitation: 0, cloud_cover: 50 }
      : { wave_height: 1 + h / 100, wave_direction: 180, wave_period: 7, wind_wave_height: 0.4, wind_wave_direction: 190, wind_wave_period: 3, swell_wave_height: 0.7, swell_wave_direction: 170, swell_wave_period: 8 };
    result.push({ locationId, timestampMs: Math.floor(departure / HOUR) * HOUR + h * HOUR, values: common });
  }
  return result;
}
const forecasts: NormalizedForecasts = { weather: rows("weather"), marine: rows("marine"), fetchedAt: new Date().toISOString() };
const service: ServiceInput = { serviceId: "x", voyageNumber: "1100", shipType: "jet", direction: "to_oshima", counterpartTerminal: "東京", scheduledDepartureJst: "2026-09-29T08:30:00+09:00", scheduledArrivalJst: "2026-09-29T10:15:00+09:00" };

test("audited feature contract contains exactly 127 ordered features", () => {
  assert.equal(NUMERIC_FEATURE_NAMES.length, 77);
  assert.equal(MODEL_FEATURE_NAMES.length, 127);
  assert.equal(new Set(MODEL_FEATURE_NAMES).size, 127);
});

test("feature order exactly matches the audited CSV", async () => {
  const csv = await readFile(new URL("docs/model/model_input_specification_127.csv", `file:///${process.cwd().replaceAll("\\", "/")}/`), "utf8");
  const names = csv.trim().split(/\r?\n/).slice(1).map((line) => line.match(/^"?\d+"?,"?([^",]+)"?,/)?.[1]);
  assert.deepEqual(names, MODEL_FEATURE_NAMES);
});

test("builds and validates 127 finite features", () => {
  const built = buildFeatures(service, forecasts);
  validateFeatures(built.vector);
  assert.equal(Object.keys(built.vector).length, 127);
  assert.equal(built.vector.estimated_duration_minutes, 105);
  assert.ok(Math.abs(built.vector.journey_wind_direction_10m_cos_mean! - 1) < 0.001);
});

test("does not silently fill missing forecast data", () => {
  const broken = { ...forecasts, marine: forecasts.marine.filter((r) => !(r.timestampMs >= Math.floor(departure / HOUR) * HOUR && r.values.wave_period)) };
  const built = buildFeatures(service, broken);
  assert.throws(() => validateFeatures(built.vector), /Feature validation failed/);
});
