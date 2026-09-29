import modelBundleJson from "../../models/cloudflare_portable_model.json" with { type: "json" };
import { runMultiModelPredictions, type MultiModelSources } from "../forecast/multi-model.js";
import { assessBatchWithFallback, assessWithFallback, GEMINI_MODELS, PROMPT_VERSION } from "../gemini/client.js";
import type { ModelBundle } from "../ml/inference.js";
import type { ServiceInput } from "../types.js";

const MODEL_BUNDLE: ModelBundle = modelBundleJson;

export async function assessService(service: ServiceInput, apiKey: string | undefined, fetchFn: typeof fetch = fetch, sources?: MultiModelSources, unavailableReason = "GEMINI_API_KEY is not configured") {
  const multiModel = await runMultiModelPredictions(service, MODEL_BUNDLE, fetchFn, sources);
  if (!apiKey) return { ml: multiModel, forecastSummary: null, ai: null, aiStatus: "unavailable" as const, error: unavailableReason, geminiModels: GEMINI_MODELS, promptVersion: PROMPT_VERSION };
  return assessWithFallback({ service, comparison: multiModel.comparison, failures: multiModel.failures }, multiModel, apiKey, fetchFn);
}

export type AssessmentResult = Awaited<ReturnType<typeof assessService>>;

export async function assessServicesBatch(services: ServiceInput[], apiKey: string | undefined, fetchFn: typeof fetch = fetch, sources?: MultiModelSources) {
  const prepared: Array<{ service: ServiceInput; input: unknown; ml: Awaited<ReturnType<typeof runMultiModelPredictions>> }> = [];
  const failures: Array<{ service: ServiceInput; error: unknown }> = [];
  for (const service of services) {
    try {
      const ml = await runMultiModelPredictions(service, MODEL_BUNDLE, fetchFn, sources);
      prepared.push({ service, ml, input: { service, comparison: ml.comparison, failures: ml.failures } });
    } catch (error) { failures.push({ service, error }); }
  }
  const results = apiKey && prepared.length
    ? await assessBatchWithFallback(prepared.map(({ service, input, ml }) => ({ serviceId: service.serviceId, input, ml })), apiKey, fetchFn)
    : prepared.map(({ ml }) => ({ ml, forecastSummary: null, ai: null, aiStatus: "unavailable" as const,
      error: apiKey ? "No services available for Gemini batch" : "GEMINI_API_KEY is not configured", geminiModels: GEMINI_MODELS, promptVersion: PROMPT_VERSION }));
  return { assessed: prepared.map((item, index) => ({ service: item.service, result: results[index]! })), failures };
}
