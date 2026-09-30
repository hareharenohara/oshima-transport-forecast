import test from "node:test";
import assert from "node:assert/strict";
import { handleRequest } from "../src/worker/index.js";
import { FORECAST_POINTS } from "../src/config/forecast-points.js";
import { MARINE_VARIABLES, WEATHER_VARIABLES } from "../src/forecast/open-meteo.js";

test("worker health reports model versions", async () => {
  const response = await handleRequest(new Request("https://example.test/health"));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "ok", modelVersion: "v2-ensemble-1", featuresVersion: "v1-127+v2-hybrid-1" });
});

test("worker serves the mobile forecast UI with security headers", async () => {
  const response = await handleRequest(new Request("https://example.test/"));
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/html/);
  assert.match(response.headers.get("content-security-policy") ?? "", /script-src 'self'/);
  assert.match(await response.text(), /大島航路予報/);
});

test("worker UI includes theme controls without the legacy duplicate history chart", async () => {
  const html = await (await handleRequest(new Request("https://example.test/"))).text();
  const css = await (await handleRequest(new Request("https://example.test/app.css"))).text();
  const js = await (await handleRequest(new Request("https://example.test/app.js"))).text();
  assert.match(html, /id="theme"/);
  assert.match(css, /data-theme="dark"/);
  assert.doesNotMatch(js, /historyChart/);
  assert.match(js, /localStorage\.setItem\('theme'/);
  assert.match(js, /prefers-color-scheme: dark/);
});

test("worker serves installable Phase 5 PWA assets", async () => {
  const html = await (await handleRequest(new Request("https://example.test/"))).text();
  const manifest = await (await handleRequest(new Request("https://example.test/manifest.webmanifest"))).json() as { name: string; icons: unknown[] };
  const serviceWorker = await (await handleRequest(new Request("https://example.test/sw.js"))).text();
  assert.match(html, /大島航路予報/);
  assert.match(html, /\/pwa\.js/);
  assert.match(html, /notification-form/);
  assert.equal(manifest.name, "大島航路予報");
  assert.ok(manifest.icons.length > 0);
  assert.match(serviceWorker, /showNotification/);
  assert.match(serviceWorker, /x-offline-stale/);
});

test("phase 6 UI renders stored history and handles a missing previous AI delta", async () => {
  const html = await (await handleRequest(new Request("https://example.test/"))).text();
  const script = await (await handleRequest(new Request("https://example.test/phase6.js"))).text();
  const serviceWorker = await (await handleRequest(new Request("https://example.test/sw.js"))).text();
  assert.match(html, /\/phase6\.js/);
  assert.match(script, /history-panel/);
  assert.match(script, /AI評価の推移/);
  assert.match(script, /evaluation_rating/);
  assert.doesNotMatch(script, /operationProbability/);
  assert.doesNotMatch(script, /%/);
  assert.match(script, /前回差は算出できません/);
  assert.match(script, /textContent\.replace\('nullポイント'/);
  assert.match(serviceWorker, /oshima-route-v9/);
});

test("worker serves model-separated weather chart assets", async () => {
  const html = await (await handleRequest(new Request("https://example.test/"))).text();
  const script = await (await handleRequest(new Request("https://example.test/weather-charts.js"))).text();
  const serviceWorker = await (await handleRequest(new Request("https://example.test/sw.js"))).text();
  assert.match(html, /\/weather-charts\.js/);
  assert.match(script, /wave_height/);
  assert.match(script, /swell_wave_height/);
  assert.match(script, /モデル別/);
  assert.match(script, /Asia\/Tokyo/);
  assert.match(script, /日本時間/);
  assert.match(serviceWorker, /oshima-route-v9/);
});

test("worker serves collapsed days and official status presentation", async () => {
  const html = await (await handleRequest(new Request("https://example.test/"))).text();
  const app = await (await handleRequest(new Request("https://example.test/app.js"))).text();
  const official = await (await handleRequest(new Request("https://example.test/official-status.js"))).text();
  assert.match(html, /\/official-status\.js/);
  assert.doesNotMatch(app, /i===0\?'open'/);
  assert.match(app, /aria-expanded="false"/);
  assert.match(app, /segmentedScale/);
  assert.doesNotMatch(app, /compactScale/);
  assert.match(app, /listShip=v=>v==='jet'\?'JF':'大型船'/);
  assert.match(app, /class="service-grade grade-badge"/);
  assert.doesNotMatch(app, /segmentedScale\('確信度'/);
  assert.doesNotMatch(app, /便ごとのAI評価の平均/);
  assert.doesNotMatch(app, /最低AI評価/);
  assert.doesNotMatch(app, /ML参考 平均/);
  assert.doesNotMatch(app, /平均就航見込み/);
  assert.match(app, /official_status/);
  assert.match(official, /公式運航情報/);
});

test("worker UI labels one-way grades and uses the most cautious daily grade", async () => {
  const app = await (await handleRequest(new Request("https://example.test/app.js"))).text();
  const css = await (await handleRequest(new Request("https://example.test/app.css"))).text();
  assert.match(app, /title="片道評価"/);
  assert.match(app, /Math\.min\(\.\.\.values\)/);
  assert.doesNotMatch(app, /visibleServices=services/);
  assert.doesNotMatch(app, /往復セットの予測/);
  assert.match(css, /round-trip-route/);
  assert.match(css, /\.day\.open \.service-list\{display:block\}/);
  assert.doesNotThrow(() => new Function(app));
});

test("the list shows both one-way departures on their own dates", async () => {
  const app = await (await handleRequest(new Request("https://example.test/app.js"))).text();
  assert.match(app, /const shown=d\.services/);
  assert.match(app, /shown\.map\(card\)/);
  assert.doesNotMatch(app, /paired_service_id/);
});

test("five-grade gauge renders every grade and leaves pending assessments unmarked", async () => {
  const app = await (await handleRequest(new Request("https://example.test/app.js"))).text();
  const css = await (await handleRequest(new Request("https://example.test/app.css"))).text();
  const source = app.slice(app.indexOf("function segmentedScale("), app.indexOf("function ring("));
  const renderGauge = new Function("rankGrade", "gradeText", "esc", source + ";return segmentedScale;")(
    ["D", "C", "B", "A", "S"],
    { D: "欠航の可能性が高い", C: "欠航寄り", B: "判断が分かれる", A: "就航寄り", S: "就航の可能性が高い" },
    (value: string) => value,
  );
  for (const [index, grade] of ["D", "C", "B", "A", "S"].entries()) {
    const html = renderGauge("", [], grade, "", "");
    assert.match(html, new RegExp(`data-grade="${grade}"`));
    assert.match(html, new RegExp(`grade-pointer" style="left:${index * 25}%"`));
    assert.equal((html.match(/grade-node active/g) ?? []).length, 1);
    assert.match(html, /role="img" aria-label="就航見通し：/);
  }
  const pending = renderGauge("", [], null, "", "");
  assert.match(pending, /評価待ち/);
  assert.doesNotMatch(pending, /grade-pointer|grade-node active/);
  assert.match(css, /\.grade-track\{[^}]*linear-gradient/);
  assert.match(css, /data-theme="dark"\] \.grade-status/);
  assert.match(css, /grid-template-columns:52px 64px minmax\(0,1fr\) 32px/);
});

test("UI timestamps use publication and omit only services without prediction data", async () => {
  const app = await (await handleRequest(new Request("https://example.test/app.js"))).text();
  const history = await (await handleRequest(new Request("https://example.test/phase6.js"))).text();
  assert.match(app, /renderUpdateTimes\(data.publishedRunSlot,data.publishedAt\)/);
  assert.match(app, /s.prediction_published_at\?new Date\(s.prediction_published_at\)/);
  assert.match(history, /at:row.published_at\|\|row.run_at/);
  const source = app.slice(app.indexOf("function forecastDaysWithData("), app.indexOf("function renderUpdateTimes("));
  const filter = new Function(source + ";return forecastDaysWithData;")();
  const available = { service_id: "weather-without-ai", prediction_created_at: "2026-09-30T06:54:00Z", ai_status: "unavailable" };
  assert.deepEqual(filter([
    { date: "2026-10-04", services: [available, { service_id: "no-data", prediction_created_at: null }] },
    { date: "2026-10-05", services: [{ prediction_created_at: null }] },
  ]), [{ date: "2026-10-04", services: [available] }]);
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

test("worker turns D1 read failures into a structured unavailable response", async () => {
  const brokenDb = { prepare() { throw new Error("database offline"); } } as unknown as D1Database;
  const response = await handleRequest(new Request("https://example.test/api/days?from=2026-09-29"), fetch, { DB: brokenDb });
  assert.equal(response.status, 503);
  const body = await response.json() as { error: { code: string } };
  assert.equal(body.error.code, "STORAGE_UNAVAILABLE");
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
  assert.equal(body.prediction.modelVersion, "v2-ensemble-1");
  assert.equal(body.dataQuality.featureCount, 192);
  assert.ok(body.prediction.cancellationProbability >= 0 && body.prediction.cancellationProbability <= 1);
});
