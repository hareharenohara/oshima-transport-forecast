import { readFile } from "node:fs/promises";
import { runMultiModelPredictions } from "./forecast/multi-model.js";
import type { ModelBundle } from "./ml/inference.js";
import { assessWithFallback } from "./gemini/client.js";
const bundle = JSON.parse(await readFile(new URL("models/cloudflare_portable_model.json", `file:///${process.cwd().replaceAll("\\", "/")}/`), "utf8")) as ModelBundle;
const result = await runMultiModelPredictions({ serviceId: "phase2-live", voyageNumber: "1100", shipType: "jet", direction: "to_oshima", counterpartTerminal: "東京", scheduledDepartureJst: "2026-09-30T08:00:00+09:00", scheduledArrivalJst: "2026-09-30T09:45:00+09:00" }, bundle);
const output = process.env.GEMINI_API_KEY
  ? { ...result, assessment: await assessWithFallback({ service: "東京→大島 1100", forecast_agreement: result.comparison, data_quality: { failures: result.failures } }, result.predictions, process.env.GEMINI_API_KEY) }
  : result;
console.log(JSON.stringify(output, null, 2));
