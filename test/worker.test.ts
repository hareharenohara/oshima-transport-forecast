import test from "node:test";
import assert from "node:assert/strict";
import { handleRequest } from "../src/worker/index.js";
import { FORECAST_POINTS } from "../src/config/forecast-points.js";
import { MARINE_VARIABLES, WEATHER_VARIABLES } from "../src/forecast/open-meteo.js";

test("worker health reports model versions", async () => {
  const response = await handleRequest(new Request("https://example.test/health"));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "ok", modelVersion: "v1-127", featuresVersion: "v1-127" });
});

test("worker rejects invalid service input before external API calls", async () => {
  let called = false;
  const response = await handleRequest(new Request("https://example.test/api/predict", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ shipType: "airplane" })
  }), async () => { called = true; throw new Error("must not run"); });
  assert.equal(response.status, 400);
  assert.equal(called, false);
  const body = await response.json() as { error: { code: string } };
  assert.equal(body.error.code, "INVALID_REQUEST");
});

test("worker rejects oversized request bodies", async () => {
  const response = await handleRequest(new Request("https://example.test/api/predict", {
    method: "POST", headers: { "content-length": "20000" }, body: "{}"
  }));
  assert.equal(response.status, 413);
});

test("worker runs forecast fixture through features and ML inference", async () => {
  const start = Date.parse("2026-09-29T00:00:00+09:00");
  const times = Array.from({ length: 72 }, (_, index) => new Date(start + index * 3_600_000 + 9 * 3_600_000).toISOString().slice(0, 16));
  const mockFetch: typeof fetch = async (input) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
    const variables = url.hostname.startsWith("marine-") ? MARINE_VARIABLES : WEATHER_VARIABLES;
    const payload = FORECAST_POINTS.map(() => ({
      hourly: Object.fromEntries([
        ["time", times],
        ...variables.map((variable) => [variable, Array(times.length).fill(variable.includes("direction") ? 180 : variable.includes("pressure") ? 1012 : variable.includes("period") ? 7 : 1)])
      ])
    }));
    return Response.json(payload);
  };
  const response = await handleRequest(new Request("https://example.test/api/predict", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      serviceId: "fixture-1100", voyageNumber: "1100", shipType: "jet", direction: "to_oshima",
      counterpartTerminal: "東京", scheduledDepartureJst: "2026-09-30T08:00:00+09:00", scheduledArrivalJst: "2026-09-30T09:45:00+09:00"
    })
  }), mockFetch);
  assert.equal(response.status, 200);
  const body = await response.json() as { prediction: { cancellationProbability: number; modelVersion: string }; dataQuality: { featureCount: number } };
  assert.equal(body.prediction.modelVersion, "v1-127");
  assert.equal(body.dataQuality.featureCount, 127);
  assert.ok(body.prediction.cancellationProbability >= 0 && body.prediction.cancellationProbability <= 1);
});
