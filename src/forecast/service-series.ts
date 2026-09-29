import { ROUTE_POINTS } from "../config/forecast-points.js";
import type { HourlyPoint, ServiceInput } from "../types.js";
import type { MultiModelSources } from "./multi-model.js";

const HOUR = 3_600_000;
const SERIES_VARIABLES = {
  wind_speed_10m: { unit: "m/s", aggregation: "route_max" },
  wind_gusts_10m: { unit: "m/s", aggregation: "route_max" },
  wave_height: { unit: "m", aggregation: "route_max" },
  wave_period: { unit: "s", aggregation: "route_mean" },
  swell_wave_height: { unit: "m", aggregation: "route_max" }
} as const;

export interface ServiceForecastSeries {
  from: string;
  to: string;
  points: Array<{ model: string; source: "weather" | "marine"; variable: keyof typeof SERIES_VARIABLES; unit: string; aggregation: string; values: Array<{ time: string; value: number }> }>;
}

function aggregate(rows: HourlyPoint[], route: Set<string>, variable: keyof typeof SERIES_VARIABLES, start: number, end: number): Array<{ time: string; value: number }> {
  const grouped = new Map<number, number[]>();
  for (const row of rows) {
    if (!route.has(row.locationId) || row.timestampMs < start || row.timestampMs > end) continue;
    const value = row.values[variable];
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    grouped.set(row.timestampMs, [...(grouped.get(row.timestampMs) ?? []), value]);
  }
  const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
  return [...grouped].sort(([a], [b]) => a - b).map(([time, values]) => ({
    time: new Date(time).toISOString(),
    value: SERIES_VARIABLES[variable].aggregation === "route_max" ? Math.max(...values) : mean(values)
  }));
}

export function buildServiceForecastSeries(service: ServiceInput, sources: MultiModelSources): ServiceForecastSeries {
  const routeIds = ROUTE_POINTS[service.counterpartTerminal];
  if (!routeIds) throw new Error(`Unsupported counterpart terminal: ${service.counterpartTerminal}`);
  const departure = Date.parse(service.scheduledDepartureJst);
  const arrival = Date.parse(service.scheduledArrivalJst);
  const start = Math.floor(departure / HOUR) * HOUR - 6 * HOUR;
  const end = Math.ceil(arrival / HOUR) * HOUR;
  const route = new Set(routeIds);
  const points: ServiceForecastSeries["points"] = [];
  for (const source of sources.weather) for (const variable of ["wind_speed_10m", "wind_gusts_10m"] as const) {
    const values = aggregate(source.rows, route, variable, start, end);
    if (values.length) points.push({ model: source.model.label, source: "weather", variable, ...SERIES_VARIABLES[variable], values });
  }
  for (const source of sources.marine) for (const variable of ["wave_height", "wave_period", "swell_wave_height"] as const) {
    const values = aggregate(source.rows, route, variable, start, end);
    if (values.length) points.push({ model: source.model.label, source: "marine", variable, ...SERIES_VARIABLES[variable], values });
  }
  return { from: new Date(start).toISOString(), to: new Date(end).toISOString(), points };
}
