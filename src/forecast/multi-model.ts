import type { NormalizedForecasts, ServiceInput } from "../types.js";
import { buildFeatures, validateFeatures } from "../ml/build-features.js";
import { buildV2HybridRawRecord } from "../ml/build-features-v2.js";
import { predictEnsembleRisk, type EnsembleModelBundle } from "../ml/inference.js";
import { compareModels } from "./model-comparison.js";
import { fetchBatch, MARINE_VARIABLES, WEATHER_VARIABLES } from "./open-meteo.js";
import { ROUTE_POINTS } from "../config/forecast-points.js";
import type { HourlyPoint } from "../types.js";

export const WEATHER_MODELS = [
  { id: "jma_msm", label: "JMA MSM", url: "https://api.open-meteo.com/v1/jma" },
  { id: "ecmwf_ifs025", label: "ECMWF IFS", url: "https://api.open-meteo.com/v1/ecmwf" },
  { id: "gfs_seamless", label: "GFS", url: "https://api.open-meteo.com/v1/gfs" }
] as const;
export const MARINE_MODELS = [
  { id: "ecmwf_wam", label: "ECMWF WAM" },
  { id: "ncep_gfswave025", label: "GFS Wave" }
] as const;

export async function fetchMultiModelSources(fetchFn: typeof fetch = fetch) {
  const weatherResults = await Promise.allSettled(WEATHER_MODELS.map(async (m) => ({ model: m, rows: await fetchBatch(m.url, WEATHER_VARIABLES, fetchFn, m.id,true) })));
  const marineResults = await Promise.allSettled(MARINE_MODELS.map(async (m) => ({ model: m, rows: await fetchBatch("https://marine-api.open-meteo.com/v1/marine", MARINE_VARIABLES, fetchFn, m.id,true) })));
  const weather = weatherResults.flatMap((r) => r.status === "fulfilled" ? [r.value] : []);
  const marine = marineResults.flatMap((r) => r.status === "fulfilled" ? [r.value] : []);
  const failures = [
    ...weatherResults.flatMap((r, i) => r.status === "rejected" ? [{ type: "weather", model: WEATHER_MODELS[i]!.label, error: String(r.reason) }] : []),
    ...marineResults.flatMap((r, i) => r.status === "rejected" ? [{ type: "marine", model: MARINE_MODELS[i]!.label, error: String(r.reason) }] : [])
  ];
  return { weather, marine, failures };
}

export type MultiModelSources = Awaited<ReturnType<typeof fetchMultiModelSources>>;

export function hasCompleteMlCoverage(service:ServiceInput,weather:HourlyPoint[],marine:HourlyPoint[]):boolean {
 const hour=3_600_000,start=Math.floor(Date.parse(service.scheduledDepartureJst)/hour)*hour-6*hour,end=Date.parse(service.scheduledArrivalJst);
 return ([[weather,WEATHER_VARIABLES],[marine,MARINE_VARIABLES]] as const).every(([rows,variables])=>{
  const index=new Map(rows.map(row=>[`${row.locationId}:${row.timestampMs}`,row.values]));
  return (ROUTE_POINTS[service.counterpartTerminal]??[]).every(point=>{
   for(let time=start;time<=end;time+=hour)if(!variables.every(variable=>Number.isFinite(index.get(`${point}:${time}`)?.[variable])))return false;
   return true;
  });
 });
}

export async function runMultiModelPredictions(service: ServiceInput, bundle: EnsembleModelBundle, fetchFn: typeof fetch = fetch, providedSources?: MultiModelSources) {
  const { weather, marine, failures } = providedSources ?? await fetchMultiModelSources(fetchFn);
  const mlFailures:Array<{weatherModel:string;marineModel:string;error:string}>=[];
  const predictions = weather.flatMap((w) => marine.flatMap((m) => {
    if(!hasCompleteMlCoverage(service,w.rows,m.rows)){
      mlFailures.push({weatherModel:w.model.label,marineModel:m.model.label,error:'Required ML variables or hourly coverage missing; no imputation'});return [];
    }
    const forecasts: NormalizedForecasts = { weather: w.rows, marine: m.rows, fetchedAt: new Date().toISOString() };
    const built = buildFeatures(service, forecasts);
    try {validateFeatures(built.vector);} catch(error) {
      mlFailures.push({weatherModel:w.model.label,marineModel:m.model.label,error:String(error)});
      return [];
    }
    const v2Raw = buildV2HybridRawRecord(service, forecasts, built.rawRecord);
    const prediction = predictEnsembleRisk(built.rawRecord, v2Raw, bundle);
    return [{
      weatherModel: w.model.label,
      marineModel: m.model.label,
      cancellationProbability: prediction.cancellationProbability,
      modelVersion: prediction.modelVersion,
      featuresVersion: prediction.featuresVersion
    }];
  }));
  if (predictions.length < 2) throw new Error(`Insufficient complete ML forecast models: ${JSON.stringify({failures,mlFailures})}`);
  const comparison = compareModels(predictions.map((p) => ({ model: `${p.weatherModel} + ${p.marineModel}`, value: p.cancellationProbability })), 0.08, 0.2);
  return { predictions, comparison, failures, mlFailures, weatherModelsAvailable: weather.length, marineModelsAvailable: marine.length };
}
