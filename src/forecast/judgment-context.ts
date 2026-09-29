import { ROUTE_POINTS } from "../config/forecast-points.js";
import { NAKAMURA_PUBLIC } from "../knowledge/nakamura-public.js";
import { TOKAI_KISEN_OFFICIAL } from "../knowledge/tokai-kisen-official.js";
import type { HourlyPoint, ServiceInput } from "../types.js";
import type { MultiModelSources } from "./multi-model.js";

const HOUR = 3_600_000;
const TERMINAL_POINTS: Record<string, readonly string[]> = {
  東京: ["tokyo_port"], 横浜: ["tokyo_bay_mouth"], 久里浜: ["uraga_channel"],
  熱海: ["atami_offshore"], 伊東: ["ito_offshore"], 稲取: ["inatori_offshore"], 館山: ["tateyama_offshore"]
};
const OSHIMA_POINTS = ["oshima_north_okata", "oshima_west_motomachi"] as const;

export interface PreviousPredictionContext {
  operationProbability: number | null;
  confidence: number | null;
  portPrediction: string | null;
  createdAt: string;
}

interface PhaseMetrics {
  departure: Record<string, number | null>;
  route: Record<string, number | null>;
  arrival: Record<string, number | null>;
  change3h: Record<string, number | null>;
  change6h: Record<string, number | null>;
}

function finite(values: Array<number | undefined>): number[] {
  return values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
}

function nearest(rows: HourlyPoint[], locations: Set<string>, target: number, variable: string): number | null {
  let candidate: { distance: number; value: number } | undefined;
  for (const row of rows) {
    if (!locations.has(row.locationId)) continue;
    const value = row.values[variable];
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    const distance = Math.abs(row.timestampMs - target);
    if (distance <= HOUR && (!candidate || distance < candidate.distance)) candidate = { distance, value };
  }
  return candidate?.value ?? null;
}

function phase(rows: HourlyPoint[], locations: Set<string>, start: number, end: number, variable: string, mode: "max" | "mean"): number | null {
  const values = finite(rows.filter((row) => locations.has(row.locationId) && row.timestampMs >= start && row.timestampMs <= end).map((row) => row.values[variable]));
  if (!values.length) return null;
  if (variable.includes("direction")) {
    const radians = values.map((value) => value * Math.PI / 180);
    const degrees = Math.atan2(radians.reduce((sum, value) => sum + Math.sin(value), 0), radians.reduce((sum, value) => sum + Math.cos(value), 0)) * 180 / Math.PI;
    return (degrees + 360) % 360;
  }
  return mode === "max" ? Math.max(...values) : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function metrics(rows: HourlyPoint[], departure: Set<string>, route: Set<string>, arrival: Set<string>, start: number, end: number, variables: readonly string[]): PhaseMetrics {
  const result: PhaseMetrics = { departure: {}, route: {}, arrival: {}, change3h: {}, change6h: {} };
  for (const variable of variables) {
    const mode = variable.includes("direction") || variable.includes("period") || variable === "pressure_msl" ? "mean" : "max";
    result.departure[variable] = phase(rows, departure, start - HOUR, start + HOUR, variable, mode);
    result.route[variable] = phase(rows, route, start, end, variable, mode);
    result.arrival[variable] = phase(rows, arrival, end - HOUR, end + HOUR, variable, mode);
    const atStart = nearest(rows, route, start, variable);
    const before3 = nearest(rows, route, start - 3 * HOUR, variable);
    const before6 = nearest(rows, route, start - 6 * HOUR, variable);
    result.change3h[variable] = atStart === null || before3 === null ? null : atStart - before3;
    result.change6h[variable] = atStart === null || before6 === null ? null : atStart - before6;
  }
  return result;
}

function thresholdStatus(forecast: number | null, threshold: number) {
  if (forecast === null) return { forecast: null, threshold, ratio: null, status: "missing" as const };
  const ratio = forecast / threshold;
  return { forecast, threshold, ratio, status: ratio >= 1 ? "reached" as const : ratio >= 0.9 ? "near_internal" as const : "below" as const };
}

export function buildJudgmentContext(service: ServiceInput, ml: unknown, sources: MultiModelSources, previous: PreviousPredictionContext | null = null, now = new Date()) {
  const routeIds = ROUTE_POINTS[service.counterpartTerminal];
  if (!routeIds) throw new Error(`Unsupported counterpart terminal: ${service.counterpartTerminal}`);
  const counterpart = TERMINAL_POINTS[service.counterpartTerminal] ?? [];
  const departureIds = service.direction === "to_oshima" ? counterpart : OSHIMA_POINTS;
  const arrivalIds = service.direction === "to_oshima" ? OSHIMA_POINTS : counterpart;
  const departure = new Set(departureIds), arrival = new Set(arrivalIds), route = new Set(routeIds);
  const start = Date.parse(service.scheduledDepartureJst), end = Date.parse(service.scheduledArrivalJst);
  const weatherVariables = ["wind_speed_10m", "wind_direction_10m", "wind_gusts_10m", "precipitation", "pressure_msl"] as const;
  const marineVariables = ["wave_height", "wave_direction", "wave_period", "wind_wave_height", "wind_wave_direction", "wind_wave_period", "swell_wave_height", "swell_wave_direction", "swell_wave_period"] as const;
  const weather = sources.weather.map((source) => ({ model: source.model.label, unit: { wind_speed_10m: "m/s", wind_direction_10m: "°", wind_gusts_10m: "m/s", precipitation: "mm", pressure_msl: "hPa" }, phases: metrics(source.rows, departure, route, arrival, start, end, weatherVariables) }));
  const marine = sources.marine.map((source) => ({ model: source.model.label, unit: { wave_height: "m", wave_direction: "°", wave_period: "s", wind_wave_height: "m", wind_wave_direction: "°", wind_wave_period: "s", swell_wave_height: "m", swell_wave_direction: "°", swell_wave_period: "s" }, phases: metrics(source.rows, departure, route, arrival, start, end, marineVariables) }));
  const official = service.shipType === "jet" ? TOKAI_KISEN_OFFICIAL.jet : TOKAI_KISEN_OFFICIAL.large;
  const routeWindThreshold = official.route.departureStop.windMs;
  const routeWaveThreshold = official.route.departureStop.waveM;
  const entry = official.oshimaEntry;
  const officialCriteria = [
    ...weather.map((item) => ({ criterion: `${service.shipType}_route_wind`, model: item.model, unit: "m/s", ...thresholdStatus(item.phases.route.wind_speed_10m ?? null, routeWindThreshold) })),
    ...marine.map((item) => ({ criterion: `${service.shipType}_route_wave`, model: item.model, unit: "m", ...thresholdStatus(item.phases.route.wave_height ?? null, routeWaveThreshold) })),
    ...(service.direction === "to_oshima" ? weather.map((item) => ({ criterion: `${service.shipType}_oshima_entry_wind`, model: item.model, unit: "m/s", ...thresholdStatus(item.phases.arrival.wind_speed_10m ?? null, entry.windMs) })) : []),
    ...(service.direction === "to_oshima" ? marine.map((item) => ({ criterion: `${service.shipType}_oshima_entry_wave`, model: item.model, unit: "m", ...thresholdStatus(item.phases.arrival.wave_height ?? null, entry.waveM) })) : []),
    ...(service.shipType === "jet" && service.direction === "to_oshima" && service.counterpartTerminal in TOKAI_KISEN_OFFICIAL.jet.departurePorts
      ? weather.map((item) => ({ criterion: `jet_departure_port_wind_${service.counterpartTerminal}`, model: item.model, unit: "m/s", ...thresholdStatus(item.phases.departure.wind_speed_10m ?? null, TOKAI_KISEN_OFFICIAL.jet.departurePorts[service.counterpartTerminal as keyof typeof TOKAI_KISEN_OFFICIAL.jet.departurePorts].windMs) })) : []),
    ...(service.shipType === "jet" && service.direction === "to_oshima" && service.counterpartTerminal in TOKAI_KISEN_OFFICIAL.jet.departurePorts
      ? marine.map((item) => ({ criterion: `jet_departure_port_wave_${service.counterpartTerminal}`, model: item.model, unit: "m", ...thresholdStatus(item.phases.departure.wave_height ?? null, TOKAI_KISEN_OFFICIAL.jet.departurePorts[service.counterpartTerminal as keyof typeof TOKAI_KISEN_OFFICIAL.jet.departurePorts].waveM) })) : [])
  ];
  return {
    service,
    timing: { departure: service.scheduledDepartureJst, arrival: service.scheduledArrivalJst, forecastHorizonHours: Math.max(0, (start - now.getTime()) / HOUR) },
    unitsPolicy: "Units are explicit below and must not be converted or inferred.",
    ml: { role: "past-outcome tendency, not final operation probability", result: ml },
    forecasts: { weather, marine },
    officialKnowledge: TOKAI_KISEN_OFFICIAL,
    officialCriteria,
    publicExperience: NAKAMURA_PUBLIC,
    previousPrediction: previous,
    dataQuality: {
      weatherModelsAvailable: sources.weather.length,
      marineModelsAvailable: sources.marine.length,
      sourceFailures: sources.failures,
      visibility: "unavailable"
    }
  };
}

