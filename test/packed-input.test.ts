import test from "node:test";
import assert from "node:assert/strict";
import { compactJudgmentInput, assessGroqBatch, GROQ_MODELS } from "../src/groq/client.js";
import { packJudgmentInputs, PACKED_PHASES, WEATHER_FIELDS, MARINE_FIELDS } from "../src/groq/packed-input.js";

function fixture(index: number) {
  const make = (models: string[], fields: readonly (readonly [string, string])[]) => models.map((m, mi) => ({ m,
    ...Object.fromEntries(PACKED_PHASES.map((p, pi) => [p, Object.fromEntries(fields.map(([key], vi) => [key, Number((index + mi * .2 + pi * .1 + vi * .01).toFixed(3))]))]))
  } as { m: string } & Record<typeof PACKED_PHASES[number], Record<string, number>>));
  return { serviceId: `service-${index}`, input: {
    s: { serviceId: `service-${index}`, scheduledDepartureJst: `${index}:00`, scheduledArrivalJst: `${index}:45`, direction: index % 2 ? "from_oshima" : "to_oshima" },
    t: { departure: `${index}:00`, arrival: `${index}:45`, forecastHorizonHours: index },
    w: make(["JMA MSM", "ECMWF IFS", "GFS"], WEATHER_FIELDS), sea: make(["ECMWF WAM", "GFS Wave"], MARINE_FIELDS),
    officialCriteria: [{ criterion: "jet_route_wave", forecast: 3.1, threshold: 3, unit: "m", status: "reached" }],
    quality: { visibility: "unavailable", sourceFailures: [{ model: "other", error: "missing" }] },
    prev: { evaluationGrade: "C" }, mlReference: { mean: .25 }
  } };
}

test("transport packing restores every model, phase and numeric value including zero and negative changes", () => {
  const items = [fixture(0), fixture(1), fixture(2)];
  items[0]!.input.w[0]!.c3!.wind_speed_10m = -2;
  delete items[1]!.input.sea[1]!.a!.swell_wave_height;
  items[2]!.input.w = []; // Entire missing source is not added by packing.
  const before = structuredClone(items);
  const packed = packJudgmentInputs(items);
  for (let i = 0; i < items.length; i++) {
    const input = packed.services[i]!.input as Record<string, unknown>;
    for (const [key, fields] of [["w", WEATHER_FIELDS], ["sea", MARINE_FIELDS]] as const) {
      const restored = (input[key] as Array<[number, Array<Array<number | null>>]>).map(([model, matrix]) => ({
        m: packed.definitions.models[model], ...Object.fromEntries(PACKED_PHASES.map((phase, pi) => [phase,
          Object.fromEntries(fields.flatMap(([name], vi) => matrix[pi]![vi] === null ? [] : [[name, matrix[pi]![vi]]]))
        ]))
      }));
      assert.deepEqual(restored, items[i]!.input[key]);
    }
    for (const key of ["officialCriteria", "quality", "prev", "mlReference"] as const) assert.deepEqual(input[key], items[i]!.input[key]);
  }
  assert.deepEqual(items, before);
  assert.equal(packed.definitions.weather[0][1], "m/s");
  assert.equal(packed.definitions.marine[8][1], "s");
});

test("removes only matching duplicate identity and time values", () => {
  const matching = fixture(1), different = fixture(2);
  different.input.s.serviceId = "different-id";
  different.input.t.arrival = "different-time";
  const packed = packJudgmentInputs([matching, different]);
  const first = packed.services[0]!.input as typeof matching.input;
  const second = packed.services[1]!.input as typeof different.input;
  assert.equal(first.s.serviceId, undefined);
  assert.equal(first.t.departure, undefined);
  assert.equal(first.s.scheduledDepartureJst, matching.input.t.departure);
  assert.equal(second.s.serviceId, "different-id");
  assert.equal(second.t.arrival, "different-time");
});

test("full-coverage four-service fixture is smaller with definitions included", () => {
  const items = [0, 1, 2, 3].map(fixture);
  const baseline = Buffer.byteLength(JSON.stringify(items));
  const packed = Buffer.byteLength(JSON.stringify(packJudgmentInputs(items)));
  assert.ok(packed < baseline * .6, `${packed} vs ${baseline}`);
});

test("rejects non-finite values rather than changing them to missing or zero", () => {
  const item = fixture(0);
  item.input.w[0]!.r.wind_speed_10m = Number.NaN;
  assert.throws(() => packJudgmentInputs([item]), /Invalid packed forecast value/);
});

test("direct Groq receives original numeric material, units and missing-value instructions", async () => {
  const phases = { departure: { wind_speed_10m: 0 }, route: { wind_speed_10m: 7 }, arrival: {}, change3h: { wind_speed_10m: -2 }, change6h: {} };
  const input = { service: { serviceId: "a" }, forecasts: { weather: [{ model: "JMA MSM", phases }], marine: [] }, officialCriteria: [] };
  const seen: string[] = [];
  await assessGroqBatch([{ serviceId: "a", input, ml: {} }], "mock", async (_, init) => {
    const body = JSON.parse(String(init?.body));
    const prompt: string = body.messages[1].content;
    seen.push(prompt);
    assert.match(prompt, /nullは欠損で0ではない/);
    const section = body.model === GROQ_MODELS.summary ? "入力:\n" : "判断材料:\n";
    const packed = JSON.parse(prompt.slice(prompt.lastIndexOf(section) + section.length));
    assert.equal(packed.definitions.weather[0][1], "m/s");
    assert.deepEqual(packed.definitions.phases,["d","r","a"]);
    assert.deepEqual(packed.definitions.matrices[packed.services[0].input.w[0][1]].map((index: number) => packed.definitions.matrixRows[index][0]), [0, 7, null]);
    const value = body.model === GROQ_MODELS.summary
      ? { risk_level: "low", model_agreement: "low", key_signals: [], rough_conditions: [], peak_conditions: [], trends: [], previous_changes: [], missing_data: [], numerical_summary: "材料不足" }
      : { evaluation_grade: "B", confidence_level: 1, assessment: "材料不足", positive_factors: [], negative_factors: [], confidence_reasons: [], official_criteria_status: [], port_prediction: "岡田", port_confidence_level: 1, port_reasons: [], summary: "材料不足" };
    return Response.json({ choices: [{ message: { content: JSON.stringify({ services: [{ service_id: "a", ...value }] }) } }] });
  });
  assert.equal(seen.length, 1);
  assert.deepEqual((compactJudgmentInput(input) as any).w[0].c3, { wind_speed_10m: -2 });
});
