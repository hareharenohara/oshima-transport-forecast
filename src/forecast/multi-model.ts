import type { NormalizedForecasts, ServiceInput } from "../types.js";
import { buildFeatures, validateFeatures } from "../ml/build-features.js";
import { predictRisk, type ModelBundle } from "../ml/inference.js";
import { compareModels } from "./model-comparison.js";
import { fetchBatch, MARINE_VARIABLES, WEATHER_VARIABLES } from "./open-meteo.js";

export const WEATHER_MODELS = [
  { id: "jma_msm", label: "JMA MSM", url: "https://api.open-meteo.com/v1/jma" },
  { id: "ecmwf_ifs025", label: "ECMWF IFS", url: "https://api.open-meteo.com/v1/ecmwf" },
  { id: "gfs_seamless", label: "GFS", url: "https://api.open-meteo.com/v1/gfs" }
] as const;
export const MARINE_MODELS = [
  { id: "ecmwf_wam", label: "ECMWF WAM" },
  { id: "ncep_gfswave025", label: "GFS Wave" }
] as const;

export async function runMultiModelPredictions(service: ServiceInput, bundle: ModelBundle, fetchFn: typeof fetch = fetch) {
  const weatherResults = await Promise.allSettled(WEATHER_MODELS.map(async (m) => ({ model: m, rows: await fetchBatch(m.url, WEATHER_VARIABLES, fetchFn, m.id) })));
  const marineResults = await Promise.allSettled(MARINE_MODELS.map(async (m) => ({ model: m, rows: await fetchBatch("https://marine-api.open-meteo.com/v1/marine", MARINE_VARIABLES, fetchFn, m.id) })));
  const weather = weatherResults.flatMap((r) => r.status === "fulfilled" ? [r.value] : []);
  const marine = marineResults.flatMap((r) => r.status === "fulfilled" ? [r.value] : []);
  const failures = [
    ...weatherResults.flatMap((r, i) => r.status === "rejected" ? [{ type: "weather", model: WEATHER_MODELS[i]!.label, error: String(r.reason) }] : []),
    ...marineResults.flatMap((r, i) => r.status === "rejected" ? [{ type: "marine", model: MARINE_MODELS[i]!.label, error: String(r.reason) }] : [])
  ];
  const predictions = weather.flatMap((w) => marine.map((m) => {
    const forecasts: NormalizedForecasts = { weather: w.rows, marine: m.rows, fetchedAt: new Date().toISOString() };
    const built = buildFeatures(service, forecasts); validateFeatures(built.vector);
    const prediction = predictRisk(built.rawRecord, bundle);
    return { weatherModel: w.model.label, marineModel: m.model.label, cancellationProbability: prediction.cancellationProbability };
  }));
  if (predictions.length < 2) throw new Error(`Insufficient forecast models: ${JSON.stringify(failures)}`);
  const comparison = compareModels(predictions.map((p) => ({ model: `${p.weatherModel} + ${p.marineModel}`, value: p.cancellationProbability })), 0.08, 0.2);
  return { predictions, comparison, failures, weatherModelsAvailable: weather.length, marineModelsAvailable: marine.length };
}
