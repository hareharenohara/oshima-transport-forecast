import { readFile } from "node:fs/promises";
import { buildFeatures, validateFeatures } from "./ml/build-features.js";
import { fetchForecasts } from "./forecast/open-meteo.js";
import { predictRisk, type ModelBundle } from "./ml/inference.js";
import type { ServiceInput } from "./types.js";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const departure = argument("departure");
const arrival = argument("arrival");
if (!departure || !arrival) {
  throw new Error("Usage: pnpm predict -- --departure 2026-09-29T08:00:00+09:00 --arrival 2026-09-29T09:45:00+09:00 [--terminal 東京 --ship jet --voyage 1100 --direction to_oshima]");
}

const service: ServiceInput = {
  serviceId: argument("id") ?? "manual-service",
  voyageNumber: argument("voyage") ?? "1100",
  shipType: (argument("ship") ?? "jet") as ServiceInput["shipType"],
  direction: (argument("direction") ?? "to_oshima") as ServiceInput["direction"],
  counterpartTerminal: argument("terminal") ?? "東京",
  scheduledDepartureJst: departure,
  scheduledArrivalJst: arrival
};

const forecasts = await fetchForecasts();
const features = buildFeatures(service, forecasts);
validateFeatures(features.vector);
const bundle = JSON.parse(await readFile(new URL("models/cloudflare_portable_model.json", `file:///${process.cwd().replaceAll("\\", "/")}/`), "utf8")) as ModelBundle;
const debug = {
  service,
  fetchedAt: forecasts.fetchedAt,
  routePointIds: features.routePointIds,
  fetchedLocationCount: new Set([...forecasts.weather, ...forecasts.marine].map((r) => r.locationId)).size,
  environmentRowsUsed: features.environmentRowsUsed,
  featureCount: Object.keys(features.vector).length,
  features: features.vector
};
try {
  console.log(JSON.stringify({ status: "ok", debug, prediction: predictRisk(features.rawRecord, bundle) }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ status: "prediction_unavailable", reason: error instanceof Error ? error.message : String(error), debug }, null, 2));
  process.exitCode = 2;
}
