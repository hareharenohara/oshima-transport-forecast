export const GEMINI_MODELS = { summary: "gemini-3.5-flash-lite", final: "gemini-3.8-flash" } as const;
export const GEMINI_MODEL_CHAINS = {
  summary: ["gemini-3.5-flash-lite", "gemini-3.6-flash"],
  final: ["gemini-3.8-flash", "gemini-3.7-flash", "gemini-3.6-flash", "gemini-3.5-flash-lite"]
} as const;
export const PROMPT_VERSION = "assessment-v10-weather-first";

export interface ForecastSummary { risk_level: "low" | "medium" | "high"; model_agreement: "high" | "medium" | "low"; key_signals: string[]; rough_conditions: string[]; peak_conditions: string[]; trends: string[]; previous_changes: string[]; missing_data: string[]; numerical_summary: string }
export interface OfficialCriterionStatus { criterion: string; forecast: number; threshold: number; unit: string; status: "below" | "near" | "reached" }
export interface FinalAssessment { evaluation_grade: "S" | "A" | "B" | "C" | "D"; confidence_level: 1 | 2 | 3 | 4 | 5; assessment: string; positive_factors: string[]; negative_factors: string[]; confidence_reasons: string[]; official_criteria_status: OfficialCriterionStatus[]; port_prediction: "元町" | "岡田" | "不明"; port_confidence_level: 1 | 2 | 3 | 4 | 5; port_reasons: string[]; summary: string }

const stringList = { type: "ARRAY", items: { type: "STRING" } };
const summarySchema = { type: "OBJECT", properties: { risk_level: { type: "STRING", enum: ["low", "medium", "high"] }, model_agreement: { type: "STRING", enum: ["high", "medium", "low"] }, key_signals: stringList, rough_conditions: stringList, peak_conditions: stringList, trends: stringList, previous_changes: stringList, missing_data: stringList, numerical_summary: { type: "STRING" } }, required: ["risk_level", "model_agreement", "key_signals", "rough_conditions", "peak_conditions", "trends", "previous_changes", "missing_data", "numerical_summary"] };
const criterionSchema = { type: "OBJECT", properties: { criterion: { type: "STRING" }, forecast: { type: "NUMBER" }, threshold: { type: "NUMBER" }, unit: { type: "STRING" }, status: { type: "STRING", enum: ["below", "near", "reached"] } }, required: ["criterion", "forecast", "threshold", "unit", "status"] };
const finalSchema = { type: "OBJECT", properties: { evaluation_grade: { type: "STRING", enum: ["S", "A", "B", "C", "D"] }, confidence_level: { type: "INTEGER", minimum: 1, maximum: 5 }, assessment: { type: "STRING" }, positive_factors: stringList, negative_factors: stringList, confidence_reasons: stringList, official_criteria_status: { type: "ARRAY", items: criterionSchema }, port_prediction: { type: "STRING", enum: ["元町", "岡田", "不明"] }, port_confidence_level: { type: "INTEGER", minimum: 1, maximum: 5 }, port_reasons: stringList, summary: { type: "STRING" } }, required: ["evaluation_grade", "confidence_level", "assessment", "positive_factors", "negative_factors", "confidence_reasons", "official_criteria_status", "port_prediction", "port_confidence_level", "port_reasons", "summary"] };
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
  return { risk_level: v.risk_level as ForecastSummary["risk_level"], model_agreement: v.model_agreement as ForecastSummary["model_agreement"], key_signals: stringArray(v.key_signals, "key_signals"), rough_conditions: stringArray(v.rough_conditions, "rough_conditions"), peak_conditions: stringArray(v.peak_conditions, "peak_conditions"), trends: stringArray(v.trends, "trends"), previous_changes: stringArray(v.previous_changes, "previous_changes"), missing_data: stringArray(v.missing_data, "missing_data"), numerical_summary: v.numerical_summary };
}

export function validateAssessment(value: unknown): FinalAssessment {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Gemini assessment is not an object");
  const v = value as Record<string, unknown>;
  if (!["S", "A", "B", "C", "D"].includes(String(v.evaluation_grade))) throw new Error("Invalid evaluation_grade");
  for (const key of ["confidence_level", "port_confidence_level"]) if (!Number.isInteger(v[key]) || (v[key] as number) < 1 || (v[key] as number) > 5) throw new Error(`Invalid ${key}`);
  for (const key of ["assessment", "summary"]) if (typeof v[key] !== "string") throw new Error(`Invalid ${key}`);
  if (!["元町", "岡田", "不明"].includes(String(v.port_prediction))) throw new Error("Invalid port_prediction");
  if (!Array.isArray(v.official_criteria_status)) throw new Error("Invalid official_criteria_status");
  const official_criteria_status = v.official_criteria_status.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Invalid official criterion");
    const criterion = item as Record<string, unknown>;
    if (typeof criterion.criterion !== "string" || typeof criterion.unit !== "string" || typeof criterion.forecast !== "number" || typeof criterion.threshold !== "number" || !["below", "near", "reached"].includes(String(criterion.status))) throw new Error("Invalid official criterion");
    return { criterion: criterion.criterion, forecast: criterion.forecast, threshold: criterion.threshold, unit: criterion.unit, status: criterion.status as OfficialCriterionStatus["status"] };
  });
  return { evaluation_grade: v.evaluation_grade as FinalAssessment["evaluation_grade"], confidence_level: v.confidence_level as FinalAssessment["confidence_level"], assessment: v.assessment as string, positive_factors: stringArray(v.positive_factors, "positive_factors"), negative_factors: stringArray(v.negative_factors, "negative_factors"), confidence_reasons: stringArray(v.confidence_reasons, "confidence_reasons"), official_criteria_status, port_prediction: v.port_prediction as FinalAssessment["port_prediction"], port_confidence_level: v.port_confidence_level as FinalAssessment["port_confidence_level"], port_reasons: stringArray(v.port_reasons, "port_reasons"), summary: v.summary as string };
}

export function validateGrounding(assessment: FinalAssessment, input: unknown): FinalAssessment {
  const source = input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>).officialCriteria : undefined;
  if (!Array.isArray(source)) return assessment;
  const available = source.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item) && typeof (item as Record<string, unknown>).forecast === "number"));
  const expectedStatus = (status: unknown) => status === "near_internal" ? "near" : status;
  const matches = (reported: OfficialCriterionStatus, item: Record<string, unknown>) => reported.criterion === item.criterion && reported.unit === item.unit
    && Math.abs(reported.forecast - Number(item.forecast)) < 1e-9 && Math.abs(reported.threshold - Number(item.threshold)) < 1e-9 && reported.status === expectedStatus(item.status);
  if (assessment.official_criteria_status.some((reported) => !available.some((item) => matches(reported, item)))) throw new Error("official_criteria_status is not grounded in input");
  const material = available.filter((item) => item.status === "near_internal" || item.status === "reached");
  if (material.some((item) => !assessment.official_criteria_status.some((reported) => matches(reported, item)))) throw new Error("official_criteria_status omitted a material criterion");
  return assessment;
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

export function generateForecastSummary(input: unknown, apiKey: string, fetchFn: typeof fetch = fetch, model: string = GEMINI_MODELS.summary, retry = true): Promise<ForecastSummary> {
  return generateStructured(model, `伊豆大島航路の予報情報だけを整理してください。就航見込みは決定しないでください。入力に存在する数値と固定知識だけを使用し、どの地点・航行段階が荒れるか、ピーク時間、風・波・うねりの3時間/6時間変化、モデル一致度、前回差、欠損を具体的な数値と単位付きで記述してください。平均だけでモデル差を隠さず、欠損・視程未取得を推測しないでください。説明文、要約、要因、根拠は自然な日本語で記述してください。モデル名、単位、正式な識別子を除き、英語の文章や語句を出力しないでください。\n入力:\n${JSON.stringify(input)}`, summarySchema, validateForecastSummary, apiKey, fetchFn, retry);
}

export function generateFinalAssessment(input: unknown, summary: ForecastSummary, apiKey: string, fetchFn: typeof fetch = fetch, model: string = GEMINI_MODELS.final, retry = true): Promise<FinalAssessment> {
  return generateStructured(model, finalPrompt(input, summary), finalSchema, (value) => validateGrounding(validateAssessment(value), input), apiKey, fetchFn, retry);
}

export function generateBatchForecastSummaries(inputs: Array<{ serviceId: string; input: unknown }>, apiKey: string, fetchFn: typeof fetch = fetch, model: string = GEMINI_MODELS.summary) {
  return generateStructured(model, `伊豆大島航路の複数便について予報情報だけを整理してください。各service_idを保持し、就航見込みは決定しないでください。入力に存在する数値と固定知識だけを使い、荒れている地点・航行段階、ピーク、風・波・うねりの変化、モデル一致度、前回差、欠損を数値と単位付きで記述してください。平均だけでモデル差を隠さず、欠損や視程を推測しないでください。説明文、要約、要因、根拠は自然な日本語で記述してください。モデル名、単位、正式な識別子を除き、英語の文章や語句を出力しないでください。\n入力:\n${JSON.stringify(inputs)}`, batchSummarySchema, (value) => validateBatch(value, validateForecastSummary), apiKey, fetchFn, false);
}

export function generateBatchFinalAssessments(inputs: Array<{ serviceId: string; input: unknown }>, summaries: Array<{ serviceId: string; value: ForecastSummary }>, apiKey: string, fetchFn: typeof fetch = fetch, model: string = GEMINI_MODELS.final) {
  const inputMap = new Map(inputs.map((item) => [item.serviceId, item.input]));
  return generateStructured(model, `${FINAL_RULES}\n複数便を航路・船種・時間帯ごとに個別判断し、各service_idを保持してください。\n3.5整理結果:\n${JSON.stringify(summaries)}\n判断材料:\n${JSON.stringify(inputs)}`, batchFinalSchema, (value) => validateBatch(value, (item) => validateAssessment(item)).map((row) => ({ ...row, value: validateGrounding(row.value, inputMap.get(row.serviceId)) })), apiKey, fetchFn, false);
}

const FINAL_RULES = `伊豆大島航路の最終総合判断を行ってください。判断順序は、欠損、便・船種・航路・時刻、出発港・航路・入港地点の風・波・うねり、3/6時間変化、東海汽船公式基準、複数モデル差、予報先、前回差、暫定評価、ML参考値との照合、最終評価、確信度、港予測、根拠です。
説明文、assessment、summary、各要因、確信度の根拠、港予測の根拠は自然な日本語で記述してください。モデル名、単位、正式な識別子を除き、英語の文章や語句を出力しないでください。
公式基準・現在の複数予報・過去実績MLを別レイヤーのまま確認してから総合してください。先に現在の気象海象だけで暫定評価を作り、ML cancellation_probabilityは最後に過去の類似条件における参考値として照合してください。MLだけを根拠に評価を決めたり、MLの大小をS〜Dへ機械的に変換したりしてはいけません。気象海象とMLが食い違う場合は気象海象を優先し、不一致をnegative_factorsまたはconfidence_reasonsに記述してください。assessmentまたはpositive_factors・negative_factorsには、入力に数値がある限り風・波・うねりの具体的な根拠を必ず含めてください。1-MLやモデル平均をそのまま最終就航見込みにしてはいけません。モデル差を平均で消してはいけません。
入力にない数値、因果、経験則を作らないでください。ジェットと大型船、東京航路と熱海等を同じ閾値で扱わないでください。公式基準到達予報は非常に強い欠航材料ですが、未来予報だけで評価を決めないでください。AIの最終判断に確率やパーセントを生成してはいけません。evaluation_gradeはS=就航の可能性が高い、A=就航寄り、B=判断が分かれる、C=欠航寄り、D=欠航の可能性が高いです。Sは気象海象に明確な懸念がなく複数予報モデルがおおむね一致する場合に限ってください。confidence_levelはその評価を現時点で信頼できる度合いで、5=非常に高い、4=高い、3=中程度、2=低い、1=非常に低いです。予報先が遠い、モデル不一致、欠損、前回急変、基準ぎりぎりではconfidence_levelを下げてください。
official_criteria_statusには入力中のofficialCriteriaから判断に実際に使った項目だけを、forecast/threshold/unitを変更せず転記してください。入力のnear_internalは内部距離であり、公式警戒基準とは表現せずstatusはnearとしてください。港を根拠付きで判断できない場合は不明、port_confidence_levelは1、port_reasonsに不足情報を書いてください。港予測にも確率やパーセントを生成してはいけません。根拠文には可能な限りモデル名、地点・段階、値、単位、基準値を含めてください。`;

function finalPrompt(input: unknown, summary: ForecastSummary): string {
  return `${FINAL_RULES}\n3.5整理結果:\n${JSON.stringify(summary)}\n判断材料:\n${JSON.stringify(input)}`;
}

function mayTryFallback(error: unknown): boolean {
  const status = Number((error instanceof Error ? error.message : String(error)).match(/HTTP (\d{3})/)?.[1]);
  return ![400, 401, 403].includes(status);
}

async function tryModelChain<T>(models: readonly string[], run: (model: string) => Promise<T>): Promise<{ model: string; value: T; failures: string[] }> {
  const failures: string[] = [];
  for (const model of models) {
    try { return { model, value: await run(model), failures }; }
    catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
      if (!mayTryFallback(error)) break;
    }
  }
  throw new Error(`Gemini model chain failed: ${failures.join(" | ")}`);
}

export async function assessBatchWithFallback<T>(items: Array<{ serviceId: string; input: unknown; ml: T }>, apiKey: string, fetchFn: typeof fetch = fetch) {
  let summaryModel: string = GEMINI_MODELS.summary;
  let finalModel: string = GEMINI_MODELS.final;
  const unavailable = (error: unknown, summaries = new Map<string, ForecastSummary>()) => items.map((item) => ({
    ml: item.ml, forecastSummary: summaries.get(item.serviceId) ?? null, ai: null, aiStatus: "unavailable" as const,
    error: error instanceof Error ? error.message : String(error), geminiModels: { summary: summaryModel, final: finalModel }, promptVersion: PROMPT_VERSION
  }));
  try {
    const inputs = items.map(({ serviceId, input }) => ({ serviceId, input }));
    const summaryAttempt = await tryModelChain(GEMINI_MODEL_CHAINS.summary, (model) => generateBatchForecastSummaries(inputs, apiKey, fetchFn, model));
    summaryModel = summaryAttempt.model;
    const summaryRows = summaryAttempt.value;
    const summaries = new Map(summaryRows.map((row) => [row.serviceId, row.value]));
    if (items.some((item) => !summaries.has(item.serviceId))) return unavailable(new Error("Gemini batch summary omitted a service"), summaries);
    try {
      const finalAttempt = await tryModelChain(GEMINI_MODEL_CHAINS.final, (model) => generateBatchFinalAssessments(inputs, summaryRows, apiKey, fetchFn, model));
      finalModel = finalAttempt.model;
      const finalRows = finalAttempt.value;
      const finals = new Map(finalRows.map((row) => [row.serviceId, row.value]));
      return items.map((item) => finals.has(item.serviceId)
        ? { ml: item.ml, forecastSummary: summaries.get(item.serviceId)!, ai: finals.get(item.serviceId)!, aiStatus: "generated" as const, geminiModels: { summary: summaryModel, final: finalModel }, promptVersion: PROMPT_VERSION }
        : { ml: item.ml, forecastSummary: summaries.get(item.serviceId)!, ai: null, aiStatus: "unavailable" as const, error: "Gemini batch final omitted this service", geminiModels: { summary: summaryModel, final: finalModel }, promptVersion: PROMPT_VERSION });
    } catch (error) { return unavailable(error, summaries); }
  } catch (error) { return unavailable(error); }
}

export async function assessWithFallback<T>(input: unknown, ml: T, apiKey: string, fetchFn: typeof fetch = fetch) {
  let summaryModel: string = GEMINI_MODELS.summary;
  let finalModel: string = GEMINI_MODELS.final;
  try {
    const summaryAttempt = await tryModelChain(GEMINI_MODEL_CHAINS.summary, (model) => generateForecastSummary(input, apiKey, fetchFn, model, false));
    summaryModel = summaryAttempt.model;
    const forecastSummary = summaryAttempt.value;
    try {
      const finalAttempt = await tryModelChain(GEMINI_MODEL_CHAINS.final, (model) => generateFinalAssessment(input, forecastSummary, apiKey, fetchFn, model, false));
      finalModel = finalAttempt.model;
      return { ml, forecastSummary, ai: finalAttempt.value, aiStatus: "generated" as const, geminiModels: { summary: summaryModel, final: finalModel }, promptVersion: PROMPT_VERSION };
    } catch (error) {
      return { ml, forecastSummary, ai: null, aiStatus: "unavailable" as const, error: error instanceof Error ? error.message : String(error), geminiModels: { summary: summaryModel, final: finalModel }, promptVersion: PROMPT_VERSION };
    }
  } catch (error) {
    return { ml, forecastSummary: null, ai: null, aiStatus: "unavailable" as const, error: error instanceof Error ? error.message : String(error), geminiModels: { summary: summaryModel, final: finalModel }, promptVersion: PROMPT_VERSION };
  }
}
