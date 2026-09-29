import { validateAssessment, validateForecastSummary, validateGrounding, type FinalAssessment, type ForecastSummary } from "../gemini/client.js";

export const GROQ_MODELS = { summary: "openai/gpt-oss-20b", final: "openai/gpt-oss-120b" } as const;

const stringList = { type: "array", items: { type: "string" }, maxItems: 2 };
const criterionSchema = strictObject({
  criterion: { type: "string" }, forecast: { type: "number" }, threshold: { type: "number" }, unit: { type: "string" },
  status: { type: "string", enum: ["below", "near", "reached"] }
});
const summaryProperties = {
  risk_level: { type: "string", enum: ["low", "medium", "high"] },
  model_agreement: { type: "string", enum: ["high", "medium", "low"] },
  key_signals: stringList, rough_conditions: stringList, peak_conditions: stringList, trends: stringList,
  previous_changes: stringList, missing_data: stringList, numerical_summary: { type: "string" }
};
const finalProperties = {
  evaluation_grade: { type: "string", enum: ["A", "B", "C", "D", "E"] }, confidence_level: { type: "integer", minimum: 1, maximum: 5 },
  assessment: { type: "string" }, positive_factors: stringList, negative_factors: stringList, confidence_reasons: stringList,
  official_criteria_status: { type: "array", items: criterionSchema, maxItems: 0 }, port_prediction: { type: "string", enum: ["元町", "岡田", "不明"] },
  port_confidence_level: { type: "integer", minimum: 1, maximum: 5 }, port_reasons: stringList, summary: { type: "string" }
};
const batchSummarySchema = strictObject({ services: { type: "array", items: strictObject({ service_id: { type: "string" }, ...summaryProperties }) } });
const batchFinalSchema = strictObject({ services: { type: "array", items: strictObject({ service_id: { type: "string" }, ...finalProperties }) } });

function strictObject(properties: Record<string, unknown>) {
  return { type: "object", properties, required: Object.keys(properties), additionalProperties: false };
}

function validateBatch<T>(value: unknown, validate: (value: unknown) => T): Array<{ serviceId: string; value: T }> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Groq batch is not an object");
  const services = (value as Record<string, unknown>).services;
  if (!Array.isArray(services)) throw new Error("Groq batch services is not an array");
  const seen = new Set<string>();
  return services.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Invalid Groq batch item");
    const serviceId = (item as Record<string, unknown>).service_id;
    if (typeof serviceId !== "string" || !serviceId || seen.has(serviceId)) throw new Error("Invalid or duplicate Groq service_id");
    seen.add(serviceId);
    return { serviceId, value: validate(item) };
  });
}

async function generateStrict<T>(model: string, prompt: string, schema: object, validate: (value: unknown) => T, apiKey: string, fetchFn: typeof fetch, maxCompletionTokens: number): Promise<T> {
  const response = await fetchFn("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [{ role: "system", content: "要求されたJSONだけを返してください。与えられた根拠だけを使用してください。説明文、要約、要因、根拠は自然な日本語で記述し、モデル名、単位、正式な識別子を除いて英語の文章や語句を出力しないでください。" }, { role: "user", content: prompt }],
      temperature: 0.1,
      reasoning_effort: "low",
      max_completion_tokens: maxCompletionTokens,
      response_format: { type: "json_schema", json_schema: { name: "oshima_forecast", strict: true, schema } }
    })
  });
  if (!response.ok) {
    const detail = (await response.text()).replace(/\s+/g, " ").slice(0, 500);
    throw new Error(`Groq ${model} HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
  }
  const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
  const content = payload.choices?.[0]?.message?.content;
  if (!content) throw new Error(`Groq ${model} returned no structured output`);
  try { return validate(JSON.parse(content)); }
  catch (error) { throw new Error(`Groq ${model} returned invalid structured output: ${error instanceof Error ? error.message : String(error)}`); }
}

function compactNumber(value: unknown): unknown {
  if (typeof value === "number" && Number.isFinite(value)) return Math.round(value * 1000) / 1000;
  if (Array.isArray(value)) return value.map(compactNumber);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== null && item !== undefined)
    .map(([key, item]) => [key, compactNumber(item)]));
  return value;
}

export function compactJudgmentInput(input: unknown): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const source = input as Record<string, unknown>;
  const ml = source.ml && typeof source.ml === "object" ? (source.ml as Record<string, unknown>).result : undefined;
  const mlResult = ml && typeof ml === "object" ? ml as Record<string, unknown> : {};
  const comparison = mlResult.comparison && typeof mlResult.comparison === "object" ? mlResult.comparison as Record<string, unknown> : {};
  const forecasts = source.forecasts && typeof source.forecasts === "object" ? source.forecasts as Record<string, unknown> : {};
  const phaseSignals = (items: unknown, variables: string[]) => Array.isArray(items) ? items.map((item) => {
    const row = item && typeof item === "object" ? item as Record<string, unknown> : {};
    const phases = row.phases && typeof row.phases === "object" ? row.phases as Record<string, unknown> : {};
    const select = (name: string) => {
      const values = phases[name] && typeof phases[name] === "object" ? phases[name] as Record<string, unknown> : {};
      return Object.fromEntries(variables.filter((key) => typeof values[key] === "number").map((key) => [key, values[key]]));
    };
    return { m: row.model, d: select("departure"), r: select("route"), a: select("arrival"), c3: select("change3h"), c6: select("change6h") };
  }) : [];
  const criteria = Array.isArray(source.officialCriteria) ? source.officialCriteria.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item))) : [];
  const selectedCriteria = [...criteria.filter((item) => item.status === "near_internal" || item.status === "reached")];
  for (const criterion of new Set(criteria.map((item) => String(item.criterion)))) {
    const below = criteria.filter((item) => item.criterion === criterion && item.status === "below")
      .sort((a, b) => Number(b.ratio ?? -1) - Number(a.ratio ?? -1))[0];
    if (below) selectedCriteria.push(below);
  }
  return compactNumber({
    s: source.service,
    t: source.timing,
    ml: { mean: comparison.mean, min: comparison.min, max: comparison.max, range: comparison.range, agreement: comparison.agreement },
    w: phaseSignals(forecasts.weather, ["wind_speed_10m", "wind_gusts_10m"]),
    sea: phaseSignals(forecasts.marine, ["wave_height", "wave_period", "swell_wave_height", "swell_wave_period"]),
    officialCriteria: selectedCriteria,
    prev: source.previousPrediction,
    quality: source.dataQuality
  });
}

const SUMMARY_RULES = `複数便の予報情報を整理してください。入力配列のserviceIdをservice_idへ完全一致で転記し、就航見込みは決定しないでください。入力にある数値だけを使い、出発地点・航路・大島入口、ピーク、風・波・うねりの変化、モデル一致度、前回差、欠損を単位付きで示してください。説明文、要約、要因、根拠は自然な日本語で記述し、モデル名、単位、正式な識別子を除いて英語の文章や語句を出力しないでください。各文章は80文字以内、各配列は重要な2件以内にしてください。`;
const FINAL_RULES = `複数便を個別に判断してください。入力配列のserviceIdをservice_idへ完全一致で転記してください。ML欠航確率は過去の類似条件の傾向であり、1-MLをAIの最終就航見込みにしないでください。AIの最終判断に確率やパーセントを生成してはいけません。evaluation_gradeはA=就航の可能性が高い、B=就航寄り、C=判断が分かれる、D=欠航寄り、E=欠航の可能性が高いです。confidence_levelは評価の信頼度で5=非常に高い、4=高い、3=中程度、2=低い、1=非常に低いです。公式基準、地点別予報、モデル差、予報先、前回差を別々に確認してください。入力にない数値や因果を作らないでください。official_criteria_statusは空配列にしてください（システムが入力から正確に転記します）。各文章は100文字以内、各配列は重要な2件以内にしてください。港の根拠がなければ不明、port_confidence_levelは1にしてください。港予測にも確率やパーセントを生成してはいけません。`;

const JAPANESE_OUTPUT_RULE = "assessment、summary、各要因、確信度の根拠、港予測の根拠は自然な日本語で記述し、モデル名、単位、正式な識別子を除いて英語の文章や語句を出力しないでください。";

function materialCriteria(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return [];
  const criteria = (input as Record<string, unknown>).officialCriteria;
  if (!Array.isArray(criteria)) return [];
  return criteria.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const row = item as Record<string, unknown>;
    if (row.status !== "near_internal" && row.status !== "reached") return [];
    if (typeof row.criterion !== "string" || typeof row.forecast !== "number" || typeof row.threshold !== "number" || typeof row.unit !== "string") return [];
    return [{ criterion: row.criterion, forecast: row.forecast, threshold: row.threshold, unit: row.unit, status: row.status === "near_internal" ? "near" as const : "reached" as const }];
  });
}

export async function assessGroqBatch<T>(items: Array<{ serviceId: string; input: unknown; ml: T }>, apiKey: string, fetchFn: typeof fetch = fetch) {
  const inputs = items.map(({ serviceId, input }) => ({ serviceId, input: compactJudgmentInput(input) }));
  const summaries = await generateStrict(GROQ_MODELS.summary, `${SUMMARY_RULES}\n入力:\n${JSON.stringify(inputs)}`, batchSummarySchema,
    (value) => validateBatch(value, validateForecastSummary), apiKey, fetchFn, 3500);
  const summaryMap = new Map(summaries.map((row) => [row.serviceId, row.value]));
  if (items.some((item) => !summaryMap.has(item.serviceId))) throw new Error("Groq batch summary omitted a service");
  const inputMap = new Map(items.map((item) => [item.serviceId, item.input]));
  const finals = await generateStrict(GROQ_MODELS.final,
    `${FINAL_RULES}\n${JAPANESE_OUTPUT_RULE}\n整理結果:\n${JSON.stringify(summaries)}\n判断材料:\n${JSON.stringify(inputs)}`,
    batchFinalSchema,
    (value) => validateBatch(value, validateAssessment).map((row) => {
      const input = inputMap.get(row.serviceId);
      const grounded = { ...row.value, official_criteria_status: materialCriteria(input) };
      return { ...row, value: validateGrounding(grounded, input) };
    }),
    apiKey, fetchFn, 7500);
  const finalMap = new Map(finals.map((row) => [row.serviceId, row.value]));
  if (items.some((item) => !finalMap.has(item.serviceId))) throw new Error("Groq batch final omitted a service");
  return items.map((item) => ({
    ml: item.ml, forecastSummary: summaryMap.get(item.serviceId)!, ai: finalMap.get(item.serviceId)!, aiStatus: "generated" as const,
    geminiModels: { summary: GROQ_MODELS.summary, final: GROQ_MODELS.final },
    aiProviders: { summary: "groq", final: "groq" }, promptVersion: "assessment-v8-groq-japanese"
  }));
}

export async function assessGroqSingle<T>(input: unknown, ml: T, apiKey: string, fetchFn: typeof fetch = fetch) {
  const source = input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
  const service = source.service && typeof source.service === "object" && !Array.isArray(source.service) ? source.service as Record<string, unknown> : {};
  const serviceId = typeof service.serviceId === "string" && service.serviceId ? service.serviceId : "single";
  const [result] = await assessGroqBatch([{ serviceId, input, ml }], apiKey, fetchFn);
  return result!;
}
