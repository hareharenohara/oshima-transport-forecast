import modelBundleJson from "../../models/cloudflare_portable_model.v2.json" with { type: "json" };
import { fetchMultiModelSources, runMultiModelPredictions, type MultiModelSources } from "../forecast/multi-model.js";
import { buildJudgmentContext, type PreviousPredictionContext } from "../forecast/judgment-context.js";
import { assessBatchWithProviderFallback, assessSingleWithProviderFallback, type AiCredentials } from "../ai/provider.js";
import type { EnsembleModelBundle } from "../ml/inference.js";
import type { ServiceInput } from "../types.js";
import { groupForecastServices } from "./forecast-groups.js";
import { GROQ_MODELS, GROQ_PROMPT_VERSION } from "../groq/client.js";
import type { RateClock } from "../groq/rate-limit.js";
import { buildGroupJudgmentMaterial } from "./group-judgment.js";

const MODEL_BUNDLE: EnsembleModelBundle = modelBundleJson as EnsembleModelBundle;

export async function assessService(service: ServiceInput, credentials: AiCredentials, fetchFn: typeof fetch = fetch, sources?: MultiModelSources) {
  const resolvedSources = sources ?? await fetchMultiModelSources(fetchFn);
  const multiModel = await runMultiModelPredictions(service, MODEL_BUNDLE, fetchFn, resolvedSources);
  return assessSingleWithProviderFallback(buildJudgmentContext(service, multiModel, resolvedSources), multiModel, credentials, fetchFn);
}

export type AssessmentResult = Awaited<ReturnType<typeof assessService>>;

export async function assessServicesBatch(services: ServiceInput[], credentials: AiCredentials, fetchFn: typeof fetch = fetch, sources?: MultiModelSources, previous = new Map<string, PreviousPredictionContext>(), groupAsOf?: Date, clock?: RateClock, previousGroups = new Map<string, PreviousPredictionContext>()) {
  const prepared: Array<{ service: ServiceInput; input: unknown; ml: Awaited<ReturnType<typeof runMultiModelPredictions>> }> = [];
  const failures: Array<{ service: ServiceInput; error: unknown }> = [];
  for (const service of services) {
    try {
      const ml = await runMultiModelPredictions(service, MODEL_BUNDLE, fetchFn, sources);
      if (!sources) throw new Error("Shared multi-model sources are required for batched judgment context");
      prepared.push({ service, ml, input: buildJudgmentContext(service, ml, sources, previous.get(service.serviceId) ?? null) });
    } catch (error) { failures.push({ service, error }); }
  }
  const groups = groupAsOf ? groupForecastServices(prepared.map(item => item.service), groupAsOf) : [];
  const groupedIds = new Set(groups.flatMap(group => group.members.map(service => service.serviceId)));
  const individual = prepared.filter(item => !groupedIds.has(item.service.serviceId));
  const groupItems = groups.map(group => {
    const members=group.members.map(service=>({serviceId:service.serviceId,input:prepared.find(item=>item.service.serviceId===service.serviceId)!.input}));
    return {serviceId:group.id,input:{scope:"group",label:group.label,previousPrediction:previousGroups.get(group.id)??null,members,
      aggregateJudgment:buildGroupJudgmentMaterial(group,members,sources!)},ml:prepared.find(item=>item.service.serviceId===group.members[0]!.serviceId)!.ml};
  });
  const items = [...individual.map(({ service, input, ml }) => ({ serviceId: service.serviceId, input, ml, dailyDate: service.scheduledDepartureJst.slice(0,10) })), ...groupItems.map(item=>({...item,dailyDate:groups.find(group=>group.id===item.serviceId)!.date}))];
  const results = items.length
    ? await assessBatchWithProviderFallback(items, credentials, fetchFn, clock)
    : [];
  const individualResults = new Map(individual.map((item, index) => [item.service.serviceId, results[index]!]));
  const grouped = groups.map((group, index) => ({ group, result: results[individual.length + index]! }));
  const dates = [...new Set(services.map(service=>service.scheduledDepartureJst.slice(0,10)))];
  const daily = dates.map(date=>{
    const result = results.find(row=>row.dailyDate===date);
    const incomplete = failures.some(row=>row.service.scheduledDepartureJst.slice(0,10)===date);
    return {date,assessment:incomplete ? null : result?.daily ?? null,error:incomplete ? "一部の便の判断材料が不足しています。" : result?.dailyError};
  });
  return { daily, grouped, assessed: prepared.map(item => ({ service: item.service,
    result: individualResults.get(item.service.serviceId) ?? { ml: item.ml, forecastSummary: null, ai: null, aiStatus: "unavailable" as const,
      error: "便別AI評価の対象外です。日数別の集約評価を参照してください。", geminiModels: GROQ_MODELS,
      aiProviders: { summary: "none", final: "none" }, promptVersion: GROQ_PROMPT_VERSION,
      aiAudit: grouped.find(row => row.group.members.some(service => service.serviceId === item.service.serviceId))!.result.aiAudit }
  })), failures };
}
