import { ROUTE_POINTS } from "../config/forecast-points.js";
import type { HourlyPoint, NormalizedForecasts, ServiceInput } from "../types.js";
import { CATEGORY_LEVELS, MODEL_FEATURE_NAMES, NUMERIC_FEATURE_NAMES } from "./feature-names.js";

const HOUR = 3_600_000;
const floorHour = (ms: number) => Math.floor(ms / HOUR) * HOUR;
const ceilHour = (ms: number) => Math.ceil(ms / HOUR) * HOUR;
const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;

function stats(values: number[], name: string, output: Record<string, number>): void {
  if (!values.length) return;
  output[`${name}_mean`] = mean(values);
  output[`${name}_max`] = Math.max(...values);
  output[`${name}_min`] = Math.min(...values);
}

function directions(values: number[], name: string, output: Record<string, number>): void {
  if (!values.length) return;
  const radians = values.map((v) => v * Math.PI / 180);
  output[`${name}_sin_mean`] = mean(radians.map(Math.sin));
  output[`${name}_cos_mean`] = mean(radians.map(Math.cos));
}

function inWindow(rows: HourlyPoint[], locations: readonly string[], start: number, end: number): HourlyPoint[] {
  const wanted = new Set(locations);
  return rows.filter((r) => wanted.has(r.locationId) && r.timestampMs >= start && r.timestampMs <= end);
}

function values(rows: HourlyPoint[], variable: string): number[] {
  return rows.map((r) => r.values[variable]).filter((v): v is number => typeof v === "number" && Number.isFinite(v));
}

function routeAverageAt(rows: HourlyPoint[], locations: readonly string[], timestampMs: number, variable: string): number | undefined {
  const v = values(inWindow(rows, locations, timestampMs, timestampMs), variable);
  return v.length ? mean(v) : undefined;
}

function countThresholdHours(rows: HourlyPoint[], locations: readonly string[], start: number, end: number, variable: string, threshold: number): number {
  const grouped = new Map<number, number[]>();
  for (const row of inWindow(rows, locations, start, end)) {
    const value = row.values[variable];
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    grouped.set(row.timestampMs, [...(grouped.get(row.timestampMs) ?? []), value]);
  }
  return [...grouped.values()].filter((v) => Math.max(...v) >= threshold).length;
}

export interface BuiltFeatures {
  rawRecord: Record<string, string | number>;
  vector: Record<string, number>;
  routePointIds: readonly string[];
  environmentRowsUsed: number;
}

export function buildFeatures(service: ServiceInput, forecasts: NormalizedForecasts): BuiltFeatures {
  const routePointIds = ROUTE_POINTS[service.counterpartTerminal];
  if (!routePointIds) throw new Error(`Unsupported counterpart terminal: ${service.counterpartTerminal}`);
  const departure = Date.parse(service.scheduledDepartureJst);
  const arrival = Date.parse(service.scheduledArrivalJst);
  if (!Number.isFinite(departure) || !Number.isFinite(arrival) || arrival <= departure) throw new Error("Invalid scheduled JST departure/arrival");
  const start6 = departure - 6 * HOUR;
  const dataStart = floorHour(departure) - 6 * HOUR;
  const end = arrival;
  const weather = inWindow(forecasts.weather, routePointIds, dataStart, end);
  const marine = inWindow(forecasts.marine, routePointIds, dataStart, end);
  const journeyStart = floorHour(departure);
  const journeyWeather = inWindow(weather, routePointIds, journeyStart, end);
  const journeyMarine = inWindow(marine, routePointIds, journeyStart, end);
  const numeric: Record<string, number> = {};
  const scalarWeather = ["wind_speed_10m", "wind_gusts_10m", "pressure_msl", "precipitation", "cloud_cover"];
  const scalarMarine = ["wave_height", "wave_period", "wind_wave_height", "wind_wave_period", "swell_wave_height", "swell_wave_period"];
  for (const variable of scalarWeather) stats(values(journeyWeather, variable), `journey_${variable}`, numeric);
  for (const variable of scalarMarine) stats(values(journeyMarine, variable), `journey_${variable}`, numeric);
  directions(values(journeyWeather, "wind_direction_10m"), "journey_wind_direction_10m", numeric);
  for (const variable of ["wave_direction", "wind_wave_direction", "swell_wave_direction"]) directions(values(journeyMarine, variable), `journey_${variable}`, numeric);
  for (const [prefix, hours] of [["pre3h", 3], ["pre6h", 6]] as const) {
    const start = departure - hours * HOUR;
    const finish = departure;
    for (const variable of ["wind_speed_10m", "wind_gusts_10m"]) stats(values(inWindow(weather, routePointIds, start, finish), variable), `${prefix}_${variable}`, numeric);
    for (const variable of ["wave_height", "swell_wave_height"]) stats(values(inWindow(marine, routePointIds, start, finish), variable), `${prefix}_${variable}`, numeric);
  }
  const now = floorHour(departure);
  for (const [variable, rows] of [["wind_speed_10m", weather], ["wave_height", marine]] as const) {
    const current = routeAverageAt(rows, routePointIds, now, variable);
    for (const h of [3, 6]) {
      const previous = routeAverageAt(rows, routePointIds, now - h * HOUR, variable);
      if (current !== undefined && previous !== undefined) numeric[`change_${h}h_${variable}`] = current - previous;
    }
  }
  numeric.hours_route_wind_ge_10ms_pre6_to_arrival = countThresholdHours(weather, routePointIds, start6, end, "wind_speed_10m", 10);
  numeric.hours_route_wave_ge_2_5m_pre6_to_arrival = countThresholdHours(marine, routePointIds, start6, end, "wave_height", 2.5);
  numeric.estimated_duration_minutes = (arrival - departure) / 60_000;
  const jst = new Date(departure + 9 * HOUR);
  const monthAngle = 2 * Math.PI * jst.getUTCMonth() / 12;
  const hour = jst.getUTCHours() + jst.getUTCMinutes() / 60;
  numeric.departure_month_sin = Math.sin(monthAngle);
  numeric.departure_month_cos = Math.cos(monthAngle);
  numeric.departure_hour_sin = Math.sin(2 * Math.PI * hour / 24);
  numeric.departure_hour_cos = Math.cos(2 * Math.PI * hour / 24);
  numeric.departure_weekend = [0, 6].includes(jst.getUTCDay()) ? 1 : 0;

  const rawRecord: Record<string, string | number> = {
    ...numeric, ship_type: service.shipType, direction: service.direction,
    counterpart_terminal: service.counterpartTerminal, voyage_number: service.voyageNumber,
    scheduled_departure_jst: service.scheduledDepartureJst
  };
  const vector: Record<string, number> = {};
  for (const name of NUMERIC_FEATURE_NAMES) if (numeric[name] !== undefined) vector[name] = numeric[name];
  for (const [category, levels] of Object.entries(CATEGORY_LEVELS)) {
    const raw = rawRecord[category] == null ? "__MISSING__" : String(rawRecord[category]);
    for (const level of levels) vector[`${category}=${level}`] = raw === level ? 1 : 0;
  }
  return { rawRecord, vector, routePointIds, environmentRowsUsed: weather.length + marine.length };
}

export function validateFeatures(vector: Record<string, number>): void {
  const keys = Object.keys(vector);
  const missing = MODEL_FEATURE_NAMES.filter((name) => !(name in vector));
  const extras = keys.filter((name) => !MODEL_FEATURE_NAMES.includes(name));
  const invalid = keys.filter((name) => !Number.isFinite(vector[name]));
  if (keys.length !== 127 || missing.length || extras.length || invalid.length) {
    throw new Error(`Feature validation failed: count=${keys.length}, missing=${missing.join(",") || "none"}, extras=${extras.join(",") || "none"}, invalid=${invalid.join(",") || "none"}`);
  }
}
