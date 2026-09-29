export const GEMINI_MODELS = { summary: "gemini-3.5-flash-lite", final: "gemini-3.8-flash" } as const;
export const PROMPT_VERSION = "assessment-v3-batch";

export interface ForecastSummary { risk_level: "low" | "medium" | "high"; model_agreement: "high" | "medium" | "low"; key_signals: string[]; missing_data: string[]; numerical_summary: string }
export interface FinalAssessment { operation_probability: number; confidence: number; assessment: string; positive_factors: string[]; negative_factors: string[]; confidence_reasons: string[]; port_prediction: "元町" | "岡田" | "不明"; summary: string }

const summarySchema = { type: "OBJECT", properties: { risk_level: { type: "STRING", enum: ["low", "medium", "high"] }, model_agreement: { type: "STRING", enum: ["high", "medium", "low"] }, key_signals: { type: "ARRAY", items: { type: "STRING" } }, missing_data: { type: "ARRAY", items: { type: "STRING" } }, numerical_summary: { type: "STRING" } }, required: ["risk_level", "model_agreement", "key_signals", "missing_data", "numerical_summary"] };
const finalSchema = { type: "OBJECT", properties: { operation_probability: { type: "INTEGER", minimum: 0, maximum: 100 }, confidence: { type: "INTEGER", minimum: 0, maximum: 100 }, assessment: { type: "STRING" }, positive_factors: { type: "ARRAY", items: { type: "STRING" } }, negative_factors: { type: "ARRAY", items: { type: "STRING" } }, confidence_reasons: { type: "ARRAY", items: { type: "STRING" } }, port_prediction: { type: "STRING", enum: ["元町", "岡田", "不明"] }, summary: { type: "STRING" } }, required: ["operation_probability", "confidence", "assessment", "positive_factors", "negative_factors", "confidence_reasons", "port_prediction", "summary"] };
const batchSummarySchema = { type: "OBJECT", properties: { services: { type: "ARRAY", items: { type: "OBJECT", properties: { service_id: { type: "STRING" }, ...summarySchema.properties }, required: ["service_id", ...summarySchema.required] } } }, required: ["services"] };
const batchFinalSchema = { type: "OBJECT", properties: { services: { type: "ARRAY", items: { type: "OBJECT", properties: { service_id: { type: "STRING" }, ...finalSchema.properties }, required: ["service_id", ...finalSchema.required] } } }, required: ["services"] };

function stringArray(value: unknown, key: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) throw new Error(`Invalid ${key}`);
  return value;
}

export function validateForecastSummary(value: unknown): ForecastSummary {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Gemini summary is not an object");
  const v = value as Record<string, unknown>;
  if (!["low", "medium", "high"].includes(String(v.risk_level))) throw new Error("Invalid risk_level");
  if (!["high", "medium", "low"].includes(String(v.model_agreement))) throw new Error("Invalid model_agreement");
  if (typeof v.numerical_summary !== "string") throw new Error("Invalid numerical_summary");
  return { risk_level: v.risk_level as ForecastSummary["risk_level"], model_agreement: v.model_agreement as ForecastSummary["model_agreement"], key_signals: stringArray(v.key_signals, "key_signals"), missing_data: stringArray(v.missing_data, "missing_data"), numerical_summary: v.numerical_summary };
}

export function validateAssessment(value: unknown): FinalAssessment {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Gemini assessment is not an object");
  const v = value as Record<string, unknown>;
  for (const key of ["operation_probability", "confidence"]) if (!Number.isInteger(v[key]) || (v[key] as number) < 0 || (v[key] as number) > 100) throw new Error(`Invalid ${key}`);
  for (const key of ["assessment", "summary"]) if (typeof v[key] !== "string") throw new Error(`Invalid ${key}`);
  if (!["元町", "岡田", "不明"].includes(String(v.port_prediction))) throw new Error("Invalid port_prediction");
  return { operation_probability: v.operation_probability as number, confidence: v.confidence as number, assessment: v.assessment as string, positive_factors: stringArray(v.positive_factors, "positive_factors"), negative_factors: stringArray(v.negative_factors, "negative_factors"), confidence_reasons: stringArray(v.confidence_reasons, "confidence_reasons"), port_prediction: v.port_prediction as FinalAssessment["port_prediction"], summary: v.summary as string };
}

function validateBatch<T>(value: unknown, validate: (item: unknown) => T): Array<{ serviceId: string; value: T }> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Gemini batch is not an object");
  const services = (value as Record<string, unknown>).services;
  if (!Array.isArray(services)) throw new Error("Gemini batch services is not an array");
  const seen = new Set<string>();
  return services.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Invalid Gemini batch item");
    const record = item as Record<string, unknown>;
    const serviceId = typeof record.service_id === "string" ? record.service_id : "";
    if (!serviceId || seen.has(serviceId)) throw new Error("Invalid or duplicate Gemini batch service_id");
    seen.add(serviceId);
    return { serviceId, value: validate(record) };
  });
}

async function generateStructured<T>(model: string, prompt: string, schema: object, validate: (value: unknown) => T, apiKey: string, fetchFn: typeof fetch, retry = true): Promise<T> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const init: RequestInit = { method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": apiKey }, body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseMimeType: "application/json", responseSchema: schema, temperature: 0.1 } }) };
  let response = await fetchFn(url, init);
  if (retry && (response.status === 429 || response.status >= 500)) {
    const retryAfter = Number(response.headers.get("retry-after"));
    const delayMs = Number.isFinite(retryAfter) && retryAfter >= 0 ? retryAfter * 1000 : response.status === 429 ? 5_000 : 1_000;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    response = await fetchFn(url, init);
  }
  if (!response.ok) {
    const detail = (await response.text()).replace(/\s+/g, " ").slice(0, 500);
    throw new Error(`Gemini ${model} HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
  }
  const payload = await response.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
  const text = payload.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error(`Gemini ${model} returned no structured output`);
  try { return validate(JSON.parse(text)); }
  catch (error) { throw new Error(`Gemini ${model} returned invalid structured output: ${error instanceof Error ? error.message : String(error)}`); }
}

export function generateForecastSummary(input: unknown, apiKey: string, fetchFn: typeof fetch = fetch): Promise<ForecastSummary> {
  return generateStructured(GEMINI_MODELS.summary, `伊豆大島航路の予報比較を整理してください。入力中の数値だけを使い、欠損モデルを明記し、就航可否を最終判断しないでください。\n入力:\n${JSON.stringify(input)}`, summarySchema, validateForecastSummary, apiKey, fetchFn);
}

export function generateFinalAssessment(input: unknown, summary: ForecastSummary, apiKey: string, fetchFn: typeof fetch = fetch): Promise<FinalAssessment> {
  return generateStructured(GEMINI_MODELS.final, `伊豆大島航路の予測補助として最終評価してください。ML値は欠航リスクであり運航確率ではありません。数値を捏造せず、遠い予報・モデル不一致・欠損ではconfidenceを下げ、港を判断できない場合は「不明」にしてください。\n整理結果:\n${JSON.stringify(summary)}\n元入力:\n${JSON.stringify(input)}`, finalSchema, validateAssessment, apiKey, fetchFn);
}

export function generateBatchForecastSummaries(inputs: Array<{ serviceId: string; input: unknown }>, apiKey: string, fetchFn: typeof fetch = fetch) {
  return generateStructured(GEMINI_MODELS.summary, `伊豆大島航路の複数便を一括整理してください。各service_idを保持し、入力中の数値だけを使い、欠損モデルを明記し、就航可否を最終判断しないでください。\n入力:\n${JSON.stringify(inputs)}`, batchSummarySchema, (value) => validateBatch(value, validateForecastSummary), apiKey, fetchFn, false);
}

export function generateBatchFinalAssessments(inputs: Array<{ serviceId: string; input: unknown }>, summaries: Array<{ serviceId: string; value: ForecastSummary }>, apiKey: string, fetchFn: typeof fetch = fetch) {
  return generateStructured(GEMINI_MODELS.final, `伊豆大島航路の複数便を一括して最終評価してください。各service_idを保持してください。ML値は欠航リスクであり運航確率ではありません。数値を捏造せず、遠い予報・モデル不一致・欠損ではconfidenceを下げ、港を判断できない場合は「不明」にしてください。\n整理結果:\n${JSON.stringify(summaries)}\n元入力:\n${JSON.stringify(inputs)}`, batchFinalSchema, (value) => validateBatch(value, validateAssessment), apiKey, fetchFn, false);
}

export async function assessBatchWithFallback<T>(items: Array<{ serviceId: string; input: unknown; ml: T }>, apiKey: string, fetchFn: typeof fetch = fetch) {
  const unavailable = (error: unknown, summaries = new Map<string, ForecastSummary>()) => items.map((item) => ({
    ml: item.ml, forecastSummary: summaries.get(item.serviceId) ?? null, ai: null, aiStatus: "unavailable" as const,
    error: error instanceof Error ? error.message : String(error), geminiModels: GEMINI_MODELS, promptVersion: PROMPT_VERSION
  }));
  try {
    const summaryRows = await generateBatchForecastSummaries(items.map(({ serviceId, input }) => ({ serviceId, input })), apiKey, fetchFn);
    const summaries = new Map(summaryRows.map((row) => [row.serviceId, row.value]));
    if (items.some((item) => !summaries.has(item.serviceId))) return unavailable(new Error("Gemini batch summary omitted a service"), summaries);
    try {
      const finalRows = await generateBatchFinalAssessments(items.map(({ serviceId, input }) => ({ serviceId, input })), summaryRows, apiKey, fetchFn);
      const finals = new Map(finalRows.map((row) => [row.serviceId, row.value]));
      return items.map((item) => finals.has(item.serviceId)
        ? { ml: item.ml, forecastSummary: summaries.get(item.serviceId)!, ai: finals.get(item.serviceId)!, aiStatus: "generated" as const, geminiModels: GEMINI_MODELS, promptVersion: PROMPT_VERSION }
        : { ml: item.ml, forecastSummary: summaries.get(item.serviceId)!, ai: null, aiStatus: "unavailable" as const, error: "Gemini batch final omitted this service", geminiModels: GEMINI_MODELS, promptVersion: PROMPT_VERSION });
    } catch (error) { return unavailable(error, summaries); }
  } catch (error) { return unavailable(error); }
}

export async function assessWithFallback<T>(input: unknown, ml: T, apiKey: string, fetchFn: typeof fetch = fetch) {
  try {
    const forecastSummary = await generateForecastSummary(input, apiKey, fetchFn);
    try {
      const ai = await generateFinalAssessment(input, forecastSummary, apiKey, fetchFn);
      return { ml, forecastSummary, ai, aiStatus: "generated" as const, geminiModels: GEMINI_MODELS, promptVersion: PROMPT_VERSION };
    } catch (error) {
      return { ml, forecastSummary, ai: null, aiStatus: "unavailable" as const, error: error instanceof Error ? error.message : String(error), geminiModels: GEMINI_MODELS, promptVersion: PROMPT_VERSION };
    }
  } catch (error) {
    return { ml, forecastSummary: null, ai: null, aiStatus: "unavailable" as const, error: error instanceof Error ? error.message : String(error), geminiModels: GEMINI_MODELS, promptVersion: PROMPT_VERSION };
  }
}
