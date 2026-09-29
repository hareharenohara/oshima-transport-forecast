import { ROUTE_POINTS } from "../config/forecast-points.js";
import type { HourlyPoint, NormalizedForecasts, ServiceInput } from "../types.js";

const HOUR = 3_600_000;
const FIXED_POINTS = ["oshima_north_okata", "oshima_west_motomachi", "sagami_central", "uraga_channel"] as const;
const TERMINAL_POINT: Record<string, string> = {
  東京: "tokyo_port",
  横浜: "tokyo_bay_mouth",
  久里浜: "uraga_channel",
  熱海: "atami_offshore",
  伊東: "ito_offshore",
  稲取: "inatori_offshore",
  館山: "tateyama_offshore"
};
const SUFFIXES = [
  "wind_speed_10m_max",
  "wind_gusts_10m_max",
  "pressure_msl_min",
  "wave_height_max",
  "wave_period_mean",
  "swell_wave_height_max",
  "swell_wave_period_mean",
  "pre3h_wind_gusts_10m_max",
  "pre3h_wave_height_max",
  "change_6h_wind_speed_10m",
  "change_6h_wave_height",
  "hours_wind_ge_10ms_pre6_to_arrival",
  "hours_wave_ge_2_5m_pre6_to_arrival"
] as const;

const floorHour = (timestamp: number) => Math.floor(timestamp / HOUR) * HOUR;

function values(rows: HourlyPoint[], variable: string, start: number, end: number): number[] {
  return rows
    .filter((row) => row.timestampMs >= start && row.timestampMs <= end)
    .map((row) => row.values[variable])
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
}

function at(rows: HourlyPoint[], timestamp: number, variable: string): number | undefined {
  const value = rows.find((row) => row.timestampMs === timestamp)?.values[variable];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function thresholdHours(rows: HourlyPoint[], variable: string, threshold: number, start: number, end: number): number {
  return new Set(rows.filter((row) => row.timestampMs >= start && row.timestampMs <= end && (row.values[variable] ?? -Infinity) >= threshold).map((row) => row.timestampMs)).size;
}

function pointRecord(point: string, service: ServiceInput, forecasts: NormalizedForecasts): Record<string, number> {
  const departure = Date.parse(service.scheduledDepartureJst);
  const arrival = Date.parse(service.scheduledArrivalJst);
  const journeyStart = floorHour(departure);
  const weather = forecasts.weather.filter((row) => row.locationId === point);
  const marine = forecasts.marine.filter((row) => row.locationId === point);
  const record: Record<string, number> = {};
  const put = (suffix: string, collected: number[], operation: (input: number[]) => number) => {
    if (collected.length) record[suffix] = operation(collected);
  };
  put("wind_speed_10m_max", values(weather, "wind_speed_10m", journeyStart, arrival), (input) => Math.max(...input));
  put("wind_gusts_10m_max", values(weather, "wind_gusts_10m", journeyStart, arrival), (input) => Math.max(...input));
  put("pressure_msl_min", values(weather, "pressure_msl", journeyStart, arrival), (input) => Math.min(...input));
  put("wave_height_max", values(marine, "wave_height", journeyStart, arrival), (input) => Math.max(...input));
  put("wave_period_mean", values(marine, "wave_period", journeyStart, arrival), (input) => input.reduce((sum, value) => sum + value, 0) / input.length);
  put("swell_wave_height_max", values(marine, "swell_wave_height", journeyStart, arrival), (input) => Math.max(...input));
  put("swell_wave_period_mean", values(marine, "swell_wave_period", journeyStart, arrival), (input) => input.reduce((sum, value) => sum + value, 0) / input.length);
  put("pre3h_wind_gusts_10m_max", values(weather, "wind_gusts_10m", departure - 3 * HOUR, departure), (input) => Math.max(...input));
  put("pre3h_wave_height_max", values(marine, "wave_height", departure - 3 * HOUR, departure), (input) => Math.max(...input));
  const now = floorHour(departure);
  const windNow = at(weather, now, "wind_speed_10m"), windBefore = at(weather, now - 6 * HOUR, "wind_speed_10m");
  const waveNow = at(marine, now, "wave_height"), waveBefore = at(marine, now - 6 * HOUR, "wave_height");
  if (windNow !== undefined && windBefore !== undefined) record.change_6h_wind_speed_10m = windNow - windBefore;
  if (waveNow !== undefined && waveBefore !== undefined) record.change_6h_wave_height = waveNow - waveBefore;
  record.hours_wind_ge_10ms_pre6_to_arrival = thresholdHours(weather, "wind_speed_10m", 10, departure - 6 * HOUR, arrival);
  record.hours_wave_ge_2_5m_pre6_to_arrival = thresholdHours(marine, "wave_height", 2.5, departure - 6 * HOUR, arrival);
  return record;
}

export function buildV2HybridRawRecord(
  service: ServiceInput,
  forecasts: NormalizedForecasts,
  v1RawRecord: Record<string, string | number>
): Record<string, string | number> {
  const routePoints = ROUTE_POINTS[service.counterpartTerminal];
  const terminalPoint = TERMINAL_POINT[service.counterpartTerminal];
  if (!routePoints || !terminalPoint) throw new Error(`Unsupported counterpart terminal: ${service.counterpartTerminal}`);
  const raw: Record<string, string | number> = { ...v1RawRecord };
  const pointCache = new Map<string, Record<string, number>>();
  const load = (point: string) => {
    const cached = pointCache.get(point);
    if (cached) return cached;
    const created = pointRecord(point, service, forecasts);
    pointCache.set(point, created);
    return created;
  };
  for (const point of FIXED_POINTS) {
    if (!routePoints.includes(point)) continue;
    const record = load(point);
    for (const suffix of SUFFIXES) if (record[suffix] !== undefined) raw[`point__${point}__${suffix}`] = record[suffix]!;
  }
  const terminal = load(terminalPoint);
  for (const suffix of SUFFIXES) if (terminal[suffix] !== undefined) raw[`role__counterpart_terminal__${suffix}`] = terminal[suffix]!;
  return raw;
}
