import test from "node:test";
import assert from "node:assert/strict";
import { assessBatchWithProviderFallback } from "../src/ai/provider.js";
import { compactJudgmentInput, GROQ_MODELS } from "../src/groq/client.js";
import { pacedGroqFetch } from "../src/groq/rate-limit.js";

function fakeClock() { let time = 0; const waits: number[] = []; return { waits, now: () => time, sleep: async (ms: number) => { waits.push(ms); time += ms; } }; }

const summary = { risk_level: "low", model_agreement: "high", key_signals: ["低リスク"], rough_conditions: [], peak_conditions: [], trends: [], previous_changes: [], missing_data: [], numerical_summary: "低リスク" };
const assessment = { evaluation_grade: "A", confidence_level: 3, assessment: "運航見込み", positive_factors: ["低リスク"], negative_factors: [], confidence_reasons: ["モデル一致"], official_criteria_status: [], port_prediction: "岡田", port_confidence_level: 1, port_reasons: ["判断材料不足"], summary: "運航可能性が高い" };

function groq(value: unknown, promptTokens: number, completionTokens: number) {
  return Response.json({ choices: [{ message: { content: JSON.stringify(value) } }], usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens } });
}

function gemini(value: unknown) {
  return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(value) }] } }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 } });
}

test("uses only gpt-oss-120b directly without a summary stage", async () => {
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
  assert.equal(japaneseInstructionCount, 1);
  assert.deepEqual(result[0]?.aiAudit.attempts.map((item) => [item.provider, item.model, item.totalTokens]), [
    ["groq", "openai/gpt-oss-120b", 150]
  ]);
});

test("does not call Gemini when Groq is unavailable", async () => {
  const items = [{ serviceId: "a", input: { officialCriteria: [] }, ml: {} }];
  const result = await assessBatchWithProviderFallback(items, { groqApiKey: "g", geminiApiKey: "m" }, async (input) => {
    const url = String(input);
    if (url.includes("api.groq.com")) return new Response("capacity", { status: 503 });
    return url.includes("flash-lite")
      ? gemini({ services: [{ service_id: "a", ...summary }] })
      : gemini({ services: [{ service_id: "a", ...assessment }] });
  });
  assert.equal(result[0]?.aiStatus, "unavailable");
  assert.equal(result[0]?.aiProviders.final, "groq");
  assert.match(result[0]?.aiAudit.primaryError ?? "", /Groq .* HTTP 503/);
  assert.deepEqual(result[0]?.aiAudit.attempts.map((item) => item.provider), ["groq"]);
});

test("compacts repeated static knowledge before sending to Groq", () => {
  const compacted = compactJudgmentInput({ service: { id: "a" }, officialKnowledge: { repeated: true }, publicExperience: { repeated: true }, officialCriteria: [] }) as Record<string, unknown>;
  assert.deepEqual(compacted.s, { id: "a" });
  assert.equal("officialKnowledge" in compacted, false);
  assert.equal("publicExperience" in compacted, false);
});

test("keeps adopted wind/wave/swell material and ML reference, excludes unused variables", () => {
  const phases = { departure: { wind_speed_10m: 8, wind_direction_10m: 45, pressure_msl: 998 }, route: { wind_gusts_10m: 16, precipitation: 3 }, arrival: {}, change3h: {}, change6h: {} };
  const seaPhases = { departure: {}, route: { wave_height: 2.4, wave_direction: 140, swell_wave_height: 1.7, swell_wave_direction: 150, swell_wave_period: 11 }, arrival: {}, change3h: {}, change6h: {} };
  const compacted = compactJudgmentInput({
    service: { id: "a" }, ml: { result: { comparison: { mean: 0.08, min: 0.04, max: 0.12, range: 0.08, agreement: "medium" } } },
    forecasts: { weather: [{ model: "JMA MSM", phases }], marine: [{ model: "ECMWF WAM", phases: seaPhases }] }, officialCriteria: []
  }) as Record<string, unknown>;
  assert.equal((compacted.w as Array<{ d: Record<string, number> }>)[0]?.d.wind_direction_10m, 45);
  assert.equal((compacted.w as Array<{ d: Record<string, number> }>)[0]?.d.pressure_msl, undefined);
  assert.equal((compacted.sea as Array<{ r: Record<string, number> }>)[0]?.r.swell_wave_period, undefined);
  assert.equal((compacted.sea as Array<{ r: Record<string, number> }>)[0]?.r.swell_wave_direction, 150);
  assert.deepEqual(compacted.mlReference, { mean: 0.08, min: 0.04, max: 0.12, range: 0.08, agreement: "medium" });
  assert.ok(Object.keys(compacted).indexOf("mlReference") > Object.keys(compacted).indexOf("sea"));
});

test("splits Groq assessments into bounded groups", async () => {
  const items = Array.from({ length: 9 }, (_, index) => ({ serviceId: `s${index}`, input: { officialCriteria: [] }, ml: { index } }));
  const groups = [items.slice(0, 5), items.slice(5)];
  let requestIndex = 0;
  const result = await assessBatchWithProviderFallback(items, { groqApiKey: "g" }, async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { model: string; messages: Array<{ content: string }> };
    const group = groups[requestIndex]!;
    const serviceIdMentions = (body.messages[1]?.content.match(/"serviceId":/g) ?? []).length;
    assert.ok(serviceIdMentions <= (body.model === GROQ_MODELS.summary ? 5 : 9));
    requestIndex++;
    return body.model === GROQ_MODELS.summary
      ? groq({ services: group.map((item) => ({ service_id: item.serviceId, ...summary })) }, 100, 20)
      : groq({ services: group.map((item) => ({ service_id: item.serviceId, ...assessment })) }, 120, 30);
  }, fakeClock());
  assert.equal(requestIndex, 2);
  assert.deepEqual(result.map((item) => item.ml), items.map((item) => item.ml));
  assert.ok(result.every((item) => item.aiStatus === "generated"));
});

test("waits before the next same-model request would exceed the minute budget", async () => {
  const clock = fakeClock();
  const send = pacedGroqFetch(async () => new Response("ok"), clock);
  const init = { body: JSON.stringify({ model: GROQ_MODELS.summary, messages: [], max_completion_tokens: 5000 }) };
  await send("https://api.groq.com", init);
  await send("https://api.groq.com", init);
  assert.ok(clock.waits[0]! >= 60_000);
});

test("records direct final omission with requested and returned IDs", async () => {
  const items = ["a", "b"].map(serviceId => ({ serviceId, input: {}, ml: {} }));
  const result = await assessBatchWithProviderFallback(items, { groqApiKey: "g" }, async () => groq({ services: [{ service_id: "a", ...assessment }] }, 100, 20), fakeClock());
  assert.match(result[0]!.error!, /stage=final, phase=service_coverage, missing=b/);
  assert.deepEqual(result[0]!.aiAudit.attempts[0]!.requestedIds, ["a", "b"]);
  assert.deepEqual(result[0]!.aiAudit.attempts[0]!.returnedIds, ["a"]);
});

test("distinguishes an API schema error from local JSON parsing", async () => {
  const item = [{ serviceId: "a", input: {}, ml: {} }];
  const api = await assessBatchWithProviderFallback(item, { groqApiKey: "g" }, async () => Response.json({ error: { message: "expected object, got array" } }, { status: 400 }), fakeClock());
  assert.match(api[0]!.error!, /stage=final, phase=api_response/);
  const local = await assessBatchWithProviderFallback(item, { groqApiKey: "g" }, async () => Response.json({ choices: [{ finish_reason: "length", message: { content: "{" } }] }), fakeClock());
  assert.match(local[0]!.error!, /stage=final, phase=completion_limit/);
  assert.equal(local[0]!.aiAudit.attempts[0]!.finishReason, "length");
});

test("records transport failures instead of losing the attempt", async () => {
  const result = await assessBatchWithProviderFallback([{ serviceId: "a", input: {}, ml: {} }], { groqApiKey: "g" }, async () => { throw new Error("Too many subrequests"); }, fakeClock());
  assert.equal(result[0]!.aiAudit.attempts[0]!.status, 0);
  assert.match(result[0]!.aiAudit.attempts[0]!.error!, /Too many subrequests/);
});

test("honors server token reset and retries a 429 once", async () => {
  const clock = fakeClock(); let calls = 0;
  const send = pacedGroqFetch(async () => ++calls === 1 ? new Response("quota", { status: 429, headers: { "retry-after": "90", "x-ratelimit-remaining-tokens": "0", "x-ratelimit-reset-tokens": "1m30s" } }) : new Response("ok"), clock);
  const result = await send("https://api.groq.com", { body: JSON.stringify({ model: GROQ_MODELS.summary, messages: [], max_completion_tokens: 100 }) });
  assert.equal(result.status, 200); assert.equal(calls, 2); assert.ok(clock.waits[0]! >= 90_000);
});

test("does not send an oversized single request just by waiting", async () => {
  const clock = fakeClock(); let calls = 0;
  const send = pacedGroqFetch(async () => { calls++; return new Response("ok"); }, clock);
  await assert.rejects(() => send("https://api.groq.com", { body: JSON.stringify({ model: GROQ_MODELS.summary, messages: [{ content: "大".repeat(6000) }], max_completion_tokens: 100 }) }), /waiting cannot reduce/);
  assert.equal(calls, 0);
});

test("identifies final-stage omissions and API shape failures separately", async () => {
  for (const failure of ["omission", "api"] as const) {
    const items = ["a", "b"].map(serviceId => ({ serviceId, input: {}, ml: {} }));
    const result = await assessBatchWithProviderFallback(items, { groqApiKey: "g" }, async (_, init) => {
      const model = JSON.parse(String(init?.body)).model;
      if (model === GROQ_MODELS.summary) return groq({ services: items.map(item => ({ service_id: item.serviceId, ...summary })) }, 100, 20);
      return failure === "omission" ? groq({ services: [{ service_id: "a", ...assessment }] }, 100, 20) : Response.json({ error: { message: "expected object, got array" } }, { status: 400 });
    }, fakeClock());
    assert.match(result[0]!.error!, failure === "omission" ? /stage=final, phase=service_coverage/ : /stage=final, phase=api_response/);
    assert.equal(result[0]!.aiAudit.attempts[0]!.stage, "final");
  }
});

test("splits oversized batches while retaining service order", async () => {
  const items = ["a", "b"].map(serviceId => ({ serviceId, input: { service: { counterpartTerminal: "大".repeat(2000)+serviceId } }, ml: { serviceId } }));
  const result = await assessBatchWithProviderFallback(items, { groqApiKey: "g" }, async (_, init) => {
    const body = JSON.parse(String(init?.body));
    const ids = [...new Set([...String(body.messages[1].content).matchAll(/"serviceId":"([^"]+)"/g)].map(match => match[1]))];
    assert.equal(ids.length, 1);
    return groq({ services: ids.map(service_id => ({ service_id, ...(body.model === GROQ_MODELS.summary ? summary : assessment) })) }, 100, 20);
  }, fakeClock());
  assert.ok(result.every(row => row.aiStatus === "generated"));
  assert.deepEqual(result.map(row => row.ml), items.map(row => row.ml));
});
