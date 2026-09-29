import { assessBatchWithFallback as assessGeminiBatch, assessWithFallback as assessGeminiSingle, GEMINI_MODELS, PROMPT_VERSION } from "../gemini/client.js";
import { assessGroqBatch, assessGroqSingle, GROQ_MODELS } from "../groq/client.js";
import type { FinalAssessment, ForecastSummary } from "../gemini/client.js";

export interface AiCredentials { groqApiKey?: string; geminiApiKey?: string }
export interface AiAttempt { provider: "groq" | "gemini"; model: string; status: number; promptTokens?: number; completionTokens?: number; totalTokens?: number }
export interface ProviderAssessmentResult<T> {
  ml: T;
  forecastSummary: ForecastSummary | null;
  ai: FinalAssessment | null;
  aiStatus: "generated" | "unavailable";
  error?: string;
  geminiModels: { summary: string; final: string };
  aiProviders: { summary: string; final: string };
  promptVersion: string;
  aiAudit: { attempts: AiAttempt[]; primaryError?: string };
}

const GROQ_BATCH_SIZE = 4;

function chunks<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
  return result;
}

function trackedFetch(fetchFn: typeof fetch, attempts: AiAttempt[]): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const response = await fetchFn(input, init);
    let provider: AiAttempt["provider"] | undefined;
    let model = "unknown";
    if (url.includes("api.groq.com")) {
      provider = "groq";
      try { model = String(JSON.parse(String(init?.body)).model ?? "unknown"); } catch { /* diagnostic only */ }
    } else if (url.includes("generativelanguage.googleapis.com")) {
      provider = "gemini";
      model = url.match(/models\/([^:]+)/)?.[1] ?? "unknown";
    }
    if (provider) {
      const attempt: AiAttempt = { provider, model, status: response.status };
      try {
        const payload = await response.clone().json() as { usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }; usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number } };
        attempt.promptTokens = payload.usage?.prompt_tokens ?? payload.usageMetadata?.promptTokenCount;
        attempt.completionTokens = payload.usage?.completion_tokens ?? payload.usageMetadata?.candidatesTokenCount;
        attempt.totalTokens = payload.usage?.total_tokens ?? payload.usageMetadata?.totalTokenCount;
      } catch { /* an error response may not contain JSON usage */ }
      attempts.push(attempt);
    }
    return response;
  };
}

function attachAudit<T extends object>(results: T[], attempts: AiAttempt[], primaryError?: string): Array<T & { aiAudit: { attempts: AiAttempt[]; primaryError?: string } }> {
  const audit = { attempts, ...(primaryError ? { primaryError } : {}) };
  return results.map((result) => ({ ...result, aiAudit: audit }));
}

export async function assessBatchWithProviderFallback<T>(items: Array<{ serviceId: string; input: unknown; ml: T }>, credentials: AiCredentials, fetchFn: typeof fetch = fetch): Promise<Array<ProviderAssessmentResult<T>>> {
  const attempts: AiAttempt[] = [];
  const instrumented = trackedFetch(fetchFn, attempts);
  const results: Array<Omit<ProviderAssessmentResult<T>, "aiAudit">> = [];
  const errors: string[] = [];
  for (const group of chunks(items, GROQ_BATCH_SIZE)) {
    let primaryError: string | undefined;
    if (credentials.groqApiKey) {
      try {
        results.push(...await assessGroqBatch(group, credentials.groqApiKey, instrumented));
        continue;
      } catch (error) {
        primaryError = error instanceof Error ? error.message : String(error);
        errors.push(primaryError);
      }
    }
    if (credentials.geminiApiKey) {
      const fallback = await assessGeminiBatch(group, credentials.geminiApiKey, instrumented);
      results.push(...fallback.map((result) => ({ ...result, aiProviders: { summary: "gemini", final: "gemini" } })));
      continue;
    }
    results.push(...group.map((item) => ({
      ml: item.ml, forecastSummary: null, ai: null, aiStatus: "unavailable" as const,
      error: primaryError ?? "No AI provider API key is configured", geminiModels: credentials.groqApiKey ? GROQ_MODELS : GEMINI_MODELS,
      aiProviders: { summary: credentials.groqApiKey ? "groq" : "none", final: credentials.groqApiKey ? "groq" : "none" }, promptVersion: credentials.groqApiKey ? "assessment-v10-groq-weather-first" : PROMPT_VERSION
    })));
  }
  return attachAudit(results, attempts, errors.length ? errors.join(" | ") : undefined);
}

export async function assessSingleWithProviderFallback<T>(input: unknown, ml: T, credentials: AiCredentials, fetchFn: typeof fetch = fetch): Promise<ProviderAssessmentResult<T>> {
  const attempts: AiAttempt[] = [];
  const instrumented = trackedFetch(fetchFn, attempts);
  let primaryError: string | undefined;
  if (credentials.groqApiKey) {
    try { return attachAudit([await assessGroqSingle(input, ml, credentials.groqApiKey, instrumented)], attempts)[0]!; }
    catch (error) { primaryError = error instanceof Error ? error.message : String(error); }
  }
  if (credentials.geminiApiKey) {
    const result = await assessGeminiSingle(input, ml, credentials.geminiApiKey, instrumented);
    return attachAudit([{ ...result, aiProviders: { summary: "gemini", final: "gemini" } }], attempts, primaryError)[0]!;
  }
  return attachAudit([{ ml, forecastSummary: null, ai: null, aiStatus: "unavailable" as const, error: primaryError ?? "No AI provider API key is configured",
    geminiModels: credentials.groqApiKey ? GROQ_MODELS : GEMINI_MODELS, aiProviders: { summary: credentials.groqApiKey ? "groq" : "none", final: credentials.groqApiKey ? "groq" : "none" },
    promptVersion: credentials.groqApiKey ? "assessment-v10-groq-weather-first" : PROMPT_VERSION }], attempts, primaryError)[0]!;
}
