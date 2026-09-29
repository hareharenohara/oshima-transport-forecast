import test from "node:test";
import assert from "node:assert/strict";
import { assessBatchWithProviderFallback } from "../src/ai/provider.js";
import { compactJudgmentInput, GROQ_MODELS } from "../src/groq/client.js";

const summary = { risk_level: "low", model_agreement: "high", key_signals: ["低リスク"], rough_conditions: [], peak_conditions: [], trends: [], previous_changes: [], missing_data: [], numerical_summary: "低リスク" };
const assessment = { evaluation_grade: "S", confidence_level: 4, assessment: "運航見込み", positive_factors: ["低リスク"], negative_factors: [], confidence_reasons: ["モデル一致"], official_criteria_status: [], port_prediction: "不明", port_confidence_level: 1, port_reasons: ["判断材料不足"], summary: "運航可能性が高い" };

function groq(value: unknown, promptTokens: number, completionTokens: number) {
  return Response.json({ choices: [{ message: { content: JSON.stringify(value) } }], usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens } });
}

function gemini(value: unknown) {
  return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(value) }] } }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 } });
}

test("uses Groq summary and gpt-oss-120b final before Gemini", async () => {
  const items = [{ serviceId: "a", input: { officialCriteria: [], officialKnowledge: { large: "omitted" }, forecasts: {} }, ml: { cancellationProbability: 0.1 } }];
  let japaneseInstructionCount = 0;
  const result = await assessBatchWithProviderFallback(items, { groqApiKey: "g", geminiApiKey: "m" }, async (_input, init) => {
    if (String(init?.body).includes("自然な日本語")) japaneseInstructionCount++;
    const body = JSON.parse(String(init?.body)) as { model: string };
    return body.model === GROQ_MODELS.summary
      ? groq({ services: [{ service_id: "a", ...summary }] }, 100, 20)
      : groq({ services: [{ service_id: "a", ...assessment }] }, 120, 30);
  });
  assert.equal(result[0]?.aiStatus, "generated");
  assert.equal(result[0]?.aiProviders.final, "groq");
  assert.equal(result[0]?.geminiModels.final, "openai/gpt-oss-120b");
  assert.equal(japaneseInstructionCount, 2);
  assert.deepEqual(result[0]?.aiAudit.attempts.map((item) => [item.provider, item.model, item.totalTokens]), [
    ["groq", "openai/gpt-oss-20b", 120], ["groq", "openai/gpt-oss-120b", 150]
  ]);
});

test("falls back to Gemini when Groq is unavailable", async () => {
  const items = [{ serviceId: "a", input: { officialCriteria: [] }, ml: {} }];
  const result = await assessBatchWithProviderFallback(items, { groqApiKey: "g", geminiApiKey: "m" }, async (input) => {
    const url = String(input);
    if (url.includes("api.groq.com")) return new Response("capacity", { status: 503 });
    return url.includes("flash-lite")
      ? gemini({ services: [{ service_id: "a", ...summary }] })
      : gemini({ services: [{ service_id: "a", ...assessment }] });
  });
  assert.equal(result[0]?.aiStatus, "generated");
  assert.equal(result[0]?.aiProviders.final, "gemini");
  assert.match(result[0]?.aiAudit.primaryError ?? "", /Groq .* HTTP 503/);
  assert.deepEqual(result[0]?.aiAudit.attempts.map((item) => item.provider), ["groq", "gemini", "gemini"]);
});

test("compacts repeated static knowledge before sending to Groq", () => {
  const compacted = compactJudgmentInput({ service: { id: "a" }, officialKnowledge: { repeated: true }, publicExperience: { repeated: true }, officialCriteria: [] }) as Record<string, unknown>;
  assert.deepEqual(compacted.s, { id: "a" });
  assert.equal("officialKnowledge" in compacted, false);
  assert.equal("publicExperience" in compacted, false);
});

test("splits Groq assessments into bounded groups", async () => {
  const items = Array.from({ length: 9 }, (_, index) => ({ serviceId: `s${index}`, input: { officialCriteria: [] }, ml: { index } }));
  const groups = [items.slice(0, 4), items.slice(4, 8), items.slice(8)];
  let requestIndex = 0;
  const result = await assessBatchWithProviderFallback(items, { groqApiKey: "g" }, async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { model: string; messages: Array<{ content: string }> };
    const group = groups[Math.floor(requestIndex / 2)]!;
    const serviceIdMentions = (body.messages[1]?.content.match(/"serviceId":/g) ?? []).length;
    assert.ok(serviceIdMentions <= (body.model === GROQ_MODELS.summary ? 5 : 9));
    requestIndex++;
    return body.model === GROQ_MODELS.summary
      ? groq({ services: group.map((item) => ({ service_id: item.serviceId, ...summary })) }, 100, 20)
      : groq({ services: group.map((item) => ({ service_id: item.serviceId, ...assessment })) }, 120, 30);
  });
  assert.equal(requestIndex, 6);
  assert.deepEqual(result.map((item) => item.ml), items.map((item) => item.ml));
  assert.ok(result.every((item) => item.aiStatus === "generated"));
});
