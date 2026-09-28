import modelBundleJson from "../../models/cloudflare_portable_model.json" with { type: "json" };
import { runMultiModelPredictions, type MultiModelSources } from "../forecast/multi-model.js";
import { assessWithFallback, GEMINI_MODELS, PROMPT_VERSION } from "../gemini/client.js";
import type { ModelBundle } from "../ml/inference.js";
import type { ServiceInput } from "../types.js";

const MODEL_BUNDLE: ModelBundle = modelBundleJson;

export async function assessService(service: ServiceInput, apiKey: string | undefined, fetchFn: typeof fetch = fetch, sources?: MultiModelSources) {
  const multiModel = await runMultiModelPredictions(service, MODEL_BUNDLE, fetchFn, sources);
  if (!apiKey) return { ml: multiModel, forecastSummary: null, ai: null, aiStatus: "unavailable" as const, error: "GEMINI_API_KEY is not configured", geminiModels: GEMINI_MODELS, promptVersion: PROMPT_VERSION };
  return assessWithFallback({ service, comparison: multiModel.comparison, failures: multiModel.failures }, multiModel, apiKey, fetchFn);
}

export type AssessmentResult = Awaited<ReturnType<typeof assessService>>;
