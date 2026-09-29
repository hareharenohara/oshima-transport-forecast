import { assessBatchWithProviderFallback } from "../ai/provider.js";
import { logRun, readLatestAiBackfill, updateAiBackfill } from "../storage/d1.js";

export async function runLatestAiBackfill(env: { DB: D1Database; GROQ_API_KEY?: string; GEMINI_API_KEY?: string }, fetchFn: typeof fetch = fetch, retryRunId?: string) {
  if (!env.GROQ_API_KEY && !env.GEMINI_API_KEY) return { status: "missing_key" };
  const target = await readLatestAiBackfill(env.DB, retryRunId);
  if (!target) return { status: "nothing_to_backfill" };
  await logRun(env.DB, target.runId, "info", "ai_backfill_attempted", undefined, `${target.items.length} services`);
  const results = await assessBatchWithProviderFallback(target.items, { groqApiKey: env.GROQ_API_KEY, geminiApiKey: env.GEMINI_API_KEY }, fetchFn);
  let generated = 0;
  for (const [index, item] of target.items.entries()) {
    const result = results[index]!;
    await updateAiBackfill(env.DB, target.runId, item.serviceId, result);
    if (result.aiStatus === "generated") generated++;
  }
  const models = results[0]?.geminiModels;
  const providers = results[0]?.aiProviders;
  const audit = results[0]?.aiAudit;
  await logRun(env.DB, target.runId, generated === target.items.length ? "info" : "warn", "ai_backfill_completed", undefined,
    JSON.stringify({ generated, targetCount: target.items.length, models, providers, attempts: audit?.attempts ?? [], primaryError: audit?.primaryError }));
  return { status: generated === target.items.length ? "completed" : "unavailable", runId: target.runId, runAt: target.runAt, targetCount: target.items.length, generated, models, providers, audit };
}
