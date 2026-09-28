import { FORECAST_POINTS } from "../config/forecast-points.js";
import type { HourlyPoint, NormalizedForecasts } from "../types.js";

export const WEATHER_VARIABLES = ["wind_speed_10m", "wind_direction_10m", "wind_gusts_10m", "pressure_msl", "precipitation", "cloud_cover"] as const;
export const MARINE_VARIABLES = ["wave_height", "wave_direction", "wave_period", "wind_wave_height", "wind_wave_direction", "wind_wave_period", "swell_wave_height", "swell_wave_direction", "swell_wave_period"] as const;

type ApiPayload = { hourly?: Record<string, Array<string | number | null>>; hourly_units?: Record<string, string> };

const parseJst = (value: string) => Date.parse(`${value}:00+09:00`);

export async function fetchBatch(base: string, variables: readonly string[], fetchFn: typeof fetch, model?: string): Promise<HourlyPoint[]> {
  const url = new URL(base);
  url.searchParams.set("latitude", FORECAST_POINTS.map((p) => p.latitude).join(","));
  url.searchParams.set("longitude", FORECAST_POINTS.map((p) => p.longitude).join(","));
  url.searchParams.set("hourly", variables.join(","));
  url.searchParams.set("timezone", "Asia/Tokyo");
  url.searchParams.set("forecast_days", "5");
  if (variables.includes("wind_speed_10m")) url.searchParams.set("wind_speed_unit", "ms");
  if (base.includes("marine")) url.searchParams.set("cell_selection", "sea");
  if (model) url.searchParams.set("models", model);
  let response = await fetchFn(url, { headers: { "User-Agent": "tokai-kisen-forecast-phase1/0.1" } });
  if (!response.ok && (response.status === 429 || response.status >= 500)) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    response = await fetchFn(url, { headers: { "User-Agent": "tokai-kisen-forecast-phase1/0.1" } });
  }
  if (!response.ok) throw new Error(`Open-Meteo batch failed: HTTP ${response.status}`);
  const decoded = await response.json() as ApiPayload | ApiPayload[];
  const payloads = Array.isArray(decoded) ? decoded : [decoded];
  if (payloads.length !== FORECAST_POINTS.length) throw new Error(`Open-Meteo returned ${payloads.length} locations; expected 11`);
  return payloads.flatMap((payload, pointIndex) => {
    const point = FORECAST_POINTS[pointIndex]!;
    const times = payload.hourly?.time;
    if (!times) throw new Error(`Open-Meteo ${point.id}: hourly.time missing`);
    return times.map((time, index) => {
      const values: Record<string, number> = {};
      for (const variable of variables) {
        const raw = payload.hourly?.[variable]?.[index];
        if (typeof raw !== "number" || !Number.isFinite(raw)) throw new Error(`Open-Meteo ${point.id}: ${variable}[${index}] missing`);
        values[variable] = raw;
      }
      return { locationId: point.id, timestampMs: parseJst(String(time)), values };
    });
  });
}

export async function fetchForecasts(fetchFn: typeof fetch = fetch): Promise<NormalizedForecasts> {
  const [weather, marine] = await Promise.all([
    fetchBatch("https://api.open-meteo.com/v1/forecast", WEATHER_VARIABLES, fetchFn),
    fetchBatch("https://marine-api.open-meteo.com/v1/marine", MARINE_VARIABLES, fetchFn)
  ]);
  return { weather, marine, fetchedAt: new Date().toISOString() };
}
