export const GEMINI_MODELS = { summary: "gemini-3.5-flash-lite", final: "gemini-3.8-flash" } as const;
export const PROMPT_VERSION = "final-v1";
export interface FinalAssessment { operation_probability: number; confidence: number; assessment: string; positive_factors: string[]; negative_factors: string[]; confidence_reasons: string[]; port_prediction: "元町" | "岡田" | "不明"; summary: string }

const schema = { type: "OBJECT", properties: { operation_probability: { type: "INTEGER", minimum: 0, maximum: 100 }, confidence: { type: "INTEGER", minimum: 0, maximum: 100 }, assessment: { type: "STRING" }, positive_factors: { type: "ARRAY", items: { type: "STRING" } }, negative_factors: { type: "ARRAY", items: { type: "STRING" } }, confidence_reasons: { type: "ARRAY", items: { type: "STRING" } }, port_prediction: { type: "STRING", enum: ["元町", "岡田", "不明"] }, summary: { type: "STRING" } }, required: ["operation_probability", "confidence", "assessment", "positive_factors", "negative_factors", "confidence_reasons", "port_prediction", "summary"] };

export function validateAssessment(x: unknown): FinalAssessment {
  if (!x || typeof x !== "object" || Array.isArray(x)) throw new Error("Gemini assessment is not an object");
  const v = x as Record<string, unknown>;
  for (const key of ["operation_probability", "confidence"]) if (!Number.isInteger(v[key]) || (v[key] as number) < 0 || (v[key] as number) > 100) throw new Error(`Invalid ${key}`);
  for (const key of ["assessment", "summary"]) if (typeof v[key] !== "string") throw new Error(`Invalid ${key}`);
  for (const key of ["positive_factors", "negative_factors", "confidence_reasons"]) if (!Array.isArray(v[key]) || !(v[key] as unknown[]).every((i) => typeof i === "string")) throw new Error(`Invalid ${key}`);
  if (!["元町", "岡田", "不明"].includes(String(v.port_prediction))) throw new Error("Invalid port_prediction");
  return { operation_probability: v.operation_probability as number, confidence: v.confidence as number, assessment: v.assessment as string, positive_factors: v.positive_factors as string[], negative_factors: v.negative_factors as string[], confidence_reasons: v.confidence_reasons as string[], port_prediction: v.port_prediction as FinalAssessment["port_prediction"], summary: v.summary as string };
}

export async function generateFinalAssessment(input: unknown, apiKey: string, fetchFn: typeof fetch = fetch): Promise<FinalAssessment> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODELS.final}:generateContent`;
  const init: RequestInit = { method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": apiKey }, body: JSON.stringify({ contents: [{ parts: [{ text: `あなたは伊豆大島航路の予測補助です。数値を捏造せず、遠い予報・モデル不一致・欠損ではconfidenceを下げてください。入力:\n${JSON.stringify(input)}` }] }], generationConfig: { responseMimeType: "application/json", responseSchema: schema } }) };
  let response = await fetchFn(url, init);
  if (response.status === 429 || response.status >= 500) { await new Promise((resolve) => setTimeout(resolve, 1000)); response = await fetchFn(url, init); }
  if (!response.ok) throw new Error(`Gemini HTTP ${response.status}`);
  const payload = await response.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
  const text = payload.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("Gemini returned no structured output");
  return validateAssessment(JSON.parse(text));
}

export async function assessWithFallback(input: unknown, ml: unknown, apiKey: string, fetchFn: typeof fetch = fetch) {
  try { return { ml, ai: await generateFinalAssessment(input, apiKey, fetchFn), aiStatus: "generated" as const, geminiModel: GEMINI_MODELS.final, promptVersion: PROMPT_VERSION }; }
  catch (error) { return { ml, ai: null, aiStatus: "unavailable" as const, error: error instanceof Error ? error.message : String(error), geminiModel: GEMINI_MODELS.final, promptVersion: PROMPT_VERSION }; }
}
