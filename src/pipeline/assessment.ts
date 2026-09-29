import modelBundleJson from "../../models/cloudflare_portable_model.v2.json" with { type: "json" };
import { fetchMultiModelSources, runMultiModelPredictions, type MultiModelSources } from "../forecast/multi-model.js";
import { buildJudgmentContext, type PreviousPredictionContext } from "../forecast/judgment-context.js";
import { assessBatchWithProviderFallback, assessSingleWithProviderFallback, type AiCredentials } from "../ai/provider.js";
import type { EnsembleModelBundle } from "../ml/inference.js";
import type { ServiceInput } from "../types.js";

const MODEL_BUNDLE: EnsembleModelBundle = modelBundleJson as EnsembleModelBundle;

export async function assessService(service: ServiceInput, credentials: AiCredentials, fetchFn: typeof fetch = fetch, sources?: MultiModelSources) {
  const resolvedSources = sources ?? await fetchMultiModelSources(fetchFn);
  const multiModel = await runMultiModelPredictions(service, MODEL_BUNDLE, fetchFn, resolvedSources);
  return assessSingleWithProviderFallback(buildJudgmentContext(service, multiModel, resolvedSources), multiModel, credentials, fetchFn);
}

export type AssessmentResult = Awaited<ReturnType<typeof assessService>>;

export async function assessServicesBatch(services: ServiceInput[], credentials: AiCredentials, fetchFn: typeof fetch = fetch, sources?: MultiModelSources, previous = new Map<string, PreviousPredictionContext>()) {
  const prepared: Array<{ service: ServiceInput; input: unknown; ml: Awaited<ReturnType<typeof runMultiModelPredictions>> }> = [];
  const failures: Array<{ service: ServiceInput; error: unknown }> = [];
  for (const service of services) {
    try {
      const ml = await runMultiModelPredictions(service, MODEL_BUNDLE, fetchFn, sources);
      if (!sources) throw new Error("Shared multi-model sources are required for batched judgment context");
      prepared.push({ service, ml, input: buildJudgmentContext(service, ml, sources, previous.get(service.serviceId) ?? null) });
    } catch (error) { failures.push({ service, error }); }
  }
  const results = prepared.length
    ? await assessBatchWithProviderFallback(prepared.map(({ service, input, ml }) => ({ serviceId: service.serviceId, input, ml })), credentials, fetchFn)
    : [];
  return { assessed: prepared.map((item, index) => ({ service: item.service, result: results[index]! })), failures };
}
