import test from "node:test";
import assert from "node:assert/strict";
import { compareModels } from "../src/forecast/model-comparison.js";
import { assessBatchWithFallback, assessWithFallback, validateAssessment, validateForecastSummary } from "../src/gemini/client.js";

const summary = (extra: Record<string, unknown> = {}) => ({ risk_level: "low", model_agreement: "high", key_signals: ["低リスク"], rough_conditions: [], peak_conditions: [], trends: [], previous_changes: [], missing_data: [], numerical_summary: "平均1%", ...extra });
const assessment = (extra: Record<string, unknown> = {}) => ({ evaluation_grade: "A", confidence_level: 4, assessment: "運航見込み", positive_factors: ["低リスク"], negative_factors: [], confidence_reasons: ["モデル一致"], official_criteria_status: [], port_prediction: "不明", port_confidence_level: 1, port_reasons: ["港判断材料不足"], summary: "運航可能性が高い", ...extra });
const candidate = (value: unknown) => Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(value) }] } }] });

test("compares forecast models", () => { const result = compareModels([{ model: "MSM", value: 10 }, { model: "ECMWF", value: 12 }, { model: "GFS", value: 11 }], 2, 5); assert.equal(result.mean, 11); assert.equal(result.agreement, "high"); });
test("validates grounded assessment", () => { const result = validateAssessment(assessment({ official_criteria_status: [{ criterion: "jet_route_wave", forecast: 2.9, threshold: 3, unit: "m", status: "near" }] })); assert.equal(result.official_criteria_status[0]?.forecast, 2.9); });
test("validates structured summary", () => assert.equal(validateForecastSummary(summary()).risk_level, "low"));
test("rejects missing grounding fields", () => assert.throws(() => validateAssessment({ evaluation_grade: "C", confidence_level: 3 }), /port_confidence_level|assessment/));
test("runs Gemini summary before final assessment", async () => {
  const called: string[] = [];
  const result = await assessWithFallback({ officialCriteria: [] }, { predictions: [] }, "x", async (input) => { const url = String(input); called.push(url); return candidate(url.includes("flash-lite") ? summary() : assessment()); });
  assert.equal(result.aiStatus, "generated"); assert.equal(result.ai?.evaluation_grade, "A"); assert.match(called[0]!, /gemini-3\.5-flash-lite/); assert.match(called[1]!, /gemini-3\.8-flash/);
});
test("preserves summary when final Gemini is unavailable", async () => {
  let calls = 0; const result = await assessWithFallback({}, { predictions: [] }, "x", async () => ++calls === 1 ? candidate(summary({ risk_level: "medium" })) : new Response("unavailable", { status: 503 }));
  assert.equal(result.aiStatus, "unavailable"); assert.equal(result.forecastSummary?.risk_level, "medium"); assert.equal(calls, 5);
});
test("Gemini failure preserves ML fallback", async () => { const result = await assessWithFallback({}, { cancellationProbability: .2 }, "x", async () => new Response("bad", { status: 500 })); assert.equal(result.ai, null); assert.deepEqual(result.ml, { cancellationProbability: .2 }); });
test("Gemini retry preserves diagnostics", async () => { let calls = 0; const result = await assessWithFallback({}, {}, "x", async () => { calls++; return new Response('{"error":{"message":"quota exceeded"}}', { status: 429, headers: { "retry-after": "0" } }); }); assert.equal(calls, 2); assert.match(result.error ?? "", /quota exceeded/); });
test("batches all services into one summary and one final call", async () => {
  const items = ["a", "b"].map((serviceId) => ({ serviceId, input: { serviceId }, ml: { serviceId } })); let calls = 0;
  const result = await assessBatchWithFallback(items, "x", async (input) => { calls++; const isSummary = String(input).includes("flash-lite"); return candidate({ services: items.map(({ serviceId }) => ({ service_id: serviceId, ...(isSummary ? summary() : assessment()) })) }); });
  assert.equal(calls, 2); assert.ok(result.every((item) => item.aiStatus === "generated"));
});
test("tries each summary model once after a 429", async () => { let calls = 0; const result = await assessBatchWithFallback([{ serviceId: "a", input: {}, ml: {} }], "x", async () => { calls++; return new Response("quota", { status: 429 }); }); assert.equal(calls, 2); assert.equal(result[0]?.aiStatus, "unavailable"); });
test("falls back from final 3.8 through 3.7 to 3.6", async () => {
  const models: string[] = []; let summarized = false;
  const result = await assessBatchWithFallback([{ serviceId: "a", input: {}, ml: {} }], "x", async (input) => { const model = String(input).match(/models\/([^:]+)/)?.[1] ?? ""; models.push(model); if (!summarized && model === "gemini-3.5-flash-lite") { summarized = true; return candidate({ services: [{ service_id: "a", ...summary() }] }); } if (model !== "gemini-3.6-flash") return new Response("capacity", { status: 503 }); return candidate({ services: [{ service_id: "a", ...assessment({ evaluation_grade: "B" }) }] }); });
  assert.deepEqual(models, ["gemini-3.5-flash-lite", "gemini-3.8-flash", "gemini-3.7-flash", "gemini-3.6-flash"]); assert.equal(result[0]?.geminiModels.final, "gemini-3.6-flash");
});
test("uses 3.5 Flash-Lite as final fallback", async () => {
  let summarized = false; const result = await assessBatchWithFallback([{ serviceId: "a", input: {}, ml: {} }], "x", async (input) => { const model = String(input).match(/models\/([^:]+)/)?.[1] ?? ""; if (!summarized && model === "gemini-3.5-flash-lite") { summarized = true; return candidate({ services: [{ service_id: "a", ...summary() }] }); } return model === "gemini-3.5-flash-lite" ? candidate({ services: [{ service_id: "a", ...assessment() }] }) : new Response("capacity", { status: 503 }); });
  assert.equal(result[0]?.geminiModels.final, "gemini-3.5-flash-lite");
});
test("accepts ordinal boundaries and rejects invalid values", () => { assert.equal(validateAssessment(assessment({ evaluation_grade: "E", confidence_level: 1, port_confidence_level: 5 })).evaluation_grade, "E"); assert.throws(() => validateAssessment(assessment({ evaluation_grade: "F" })), /evaluation_grade/); assert.throws(() => validateAssessment(assessment({ confidence_level: 6 })), /confidence_level/); });
