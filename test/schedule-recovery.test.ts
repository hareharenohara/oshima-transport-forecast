import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { ensureForecastSchedule, latestDailyScheduleTime, scheduleDates, syncScheduleResilient } from "../src/schedule/recovery.js";
import { syncSchedule } from "../src/schedule/sync.js";
import { upcomingServices } from "../src/storage/d1.js";
import type { ScheduleProvider, ScheduleService } from "../src/schedule/types.js";
import { runScheduled } from "../src/worker/scheduled.js";
import { FORECAST_POINTS } from "../src/config/forecast-points.js";
import { MARINE_VARIABLES, WEATHER_VARIABLES } from "../src/forecast/open-meteo.js";

function database() {
  const sqlite = new DatabaseSync(":memory:");
  for (const name of readdirSync("migrations").filter(name => name.endsWith(".sql")).sort()) {
    sqlite.exec(readFileSync(`migrations/${name}`, "utf8"));
  }
  const db = {
    prepare(sql: string) {
      let values: unknown[] = [];
      return {
        bind(...args: unknown[]) { values = args; return this; },
        async all() { return { results: sqlite.prepare(sql).all(...values as []) }; },
        async first() { return sqlite.prepare(sql).get(...values as []) ?? null; },
        async run() { const result = sqlite.prepare(sql).run(...values as []); return { meta: { changes: Number(result.changes) } }; }
      };
    },
    async batch(statements: Array<{ run(): Promise<unknown> }>) {
      sqlite.exec("BEGIN");
      try { const results = []; for (const statement of statements) results.push(await statement.run()); sqlite.exec("COMMIT"); return results; }
      catch (error) { sqlite.exec("ROLLBACK"); throw error; }
    }
  } as unknown as D1Database;
  return { db, sqlite };
}

function provider(failDates: Set<string> = new Set(), version = "official-html-new"): ScheduleProvider {
  return {
    name: "tokai-kisen-official-html", sourceUrl: "https://www.tokaikisen.co.jp/boarding/timetable/", sourceVersion: version,
    async load(from, to): Promise<ScheduleService[]> {
      const dates = scheduleDates(from, to);
      if (dates.some(date => failDates.has(date))) throw new Error("official unavailable");
      return dates.map(date => ({ id: `${date}-1220`, serviceDate: date, serviceNumber: "1220", shipType: "jet", origin: "東京", destination: "大島", counterpartTerminal: "東京", scheduledDepartureJst: `${date}T08:35:00+09:00`, scheduledArrivalJst: `${date}T10:20:00+09:00`, sourceUrl: this.sourceUrl, sourceVersion: version }));
    }
  };
}

test("one bad date preserves its cached service while other dates commit and remain forecastable", async () => {
  const { db, sqlite } = database();
  try {
    await syncSchedule(db, provider(new Set(), "official-html-old"), "2026-10-06", "2026-10-08", new Date("2026-10-05T18:00:00Z"));
    const report = await syncScheduleResilient(db, provider(new Set(["2026-10-07"])), "2026-10-06", "2026-10-08", new Date("2026-10-06T18:00:00Z"));
    assert.deepEqual(report.failedDates, ["2026-10-07"]);
    assert.equal(report.count, 2);
    assert.deepEqual(sqlite.prepare("SELECT service_date,source_version,schedule_active FROM services ORDER BY service_date").all().map(row => [row.service_date, row.source_version, row.schedule_active]), [
      ["2026-10-06", "official-html-new", 1], ["2026-10-07", "official-html-old", 1], ["2026-10-08", "official-html-new", 1]
    ]);
    assert.equal((await upcomingServices(db, new Date("2026-10-06T00:00:00Z"))).length, 2);
  } finally { sqlite.close(); }
});

test("forecast retries failed and missing dates even when a cached date has departures", async () => {
  const { db, sqlite } = database();
  try {
    const now = new Date("2026-10-06T00:50:00Z");
    await syncSchedule(db, provider(new Set(), "official-html-old"), "2026-10-06", "2026-10-07", new Date("2026-10-04T18:00:00Z"));
    await syncSchedule(db, provider(), "2026-10-06", "2026-10-06", new Date("2026-10-05T18:00:00Z"));
    const calls: string[] = [];
    const retry = provider();
    const load = retry.load.bind(retry);
    retry.load = async (from, to) => { calls.push(from); return load(from, to); };
    const report = await ensureForecastSchedule(db, retry, now);
    assert.deepEqual(calls, ["2026-10-07", "2026-10-08", "2026-10-09", "2026-10-10"]);
    assert.equal(report.count, 4);
    assert.deepEqual(report.failedDates, []);
    await ensureForecastSchedule(db, retry, new Date("2026-10-06T02:50:00Z"));
    assert.equal(calls.length, 4, "fresh dates are not fetched again");
  } finally { sqlite.close(); }
});

test("a transient range request failure is retried within the same sync", async () => {
  const { db, sqlite } = database();
  try {
    const retry = provider();
    const load = retry.load.bind(retry);
    let calls = 0;
    retry.load = async (from, to) => { if (++calls === 1) throw new Error("HTTP 503"); return load(from, to); };
    const report = await syncScheduleResilient(db, retry, "2026-10-06", "2026-10-07");
    assert.equal(calls, 3);
    assert.equal(report.count, 2);
    assert.deepEqual(report.failedDates, []);
  } finally { sqlite.close(); }
});

test("complete upstream outage keeps saved departures available for predictions", async () => {
  const { db, sqlite } = database();
  try {
    const now = new Date("2026-10-06T00:50:00Z");
    await syncSchedule(db, provider(), "2026-10-06", "2026-10-10", new Date("2026-10-04T18:00:00Z"));
    const before = sqlite.prepare("SELECT * FROM services ORDER BY id").all();
    const report = await ensureForecastSchedule(db, provider(new Set(scheduleDates("2026-10-06", "2026-10-10"))), now);
    assert.equal(report.failedDates.length, 5);
    assert.deepEqual(sqlite.prepare("SELECT * FROM services ORDER BY id").all(), before);
    assert.equal((await upcomingServices(db, now)).length, 4);
  } finally { sqlite.close(); }
});

test("refresh freshness uses the latest 03:00 JST, including just before midnight UTC", () => {
  assert.equal(latestDailyScheduleTime(new Date("2026-10-05T17:59:00Z")), "2026-10-04T18:00:00.000Z");
  assert.equal(latestDailyScheduleTime(new Date("2026-10-05T18:00:00Z")), "2026-10-05T18:00:00.000Z");
  assert.equal(latestDailyScheduleTime(new Date("2026-10-06T00:50:00Z")), "2026-10-05T18:00:00.000Z");
});

test("scheduled forecast completes from cached services despite complete official outage", async () => {
  const { db, sqlite } = database();
  try {
    await syncSchedule(db, provider(), "2026-10-06", "2026-10-10", new Date("2026-10-04T18:00:00Z"));
    const times = Array.from({ length: 144 }, (_, index) => new Date(Date.parse("2026-10-06T00:00:00Z") + index * 3_600_000).toISOString().slice(0, 16));
    const mockFetch: typeof fetch = async input => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
      if (url.hostname === "www.tokaikisen.co.jp") return new Response("unavailable", { status: 503 });
      const variables = url.hostname.startsWith("marine-") ? MARINE_VARIABLES : WEATHER_VARIABLES;
      return Response.json(FORECAST_POINTS.map(() => ({ hourly: Object.fromEntries([
        ["time", times], ...variables.map(variable => [variable, Array(times.length).fill(variable.includes("direction") ? 180 : variable.includes("pressure") ? 1012 : variable.includes("period") ? 7 : 1)])
      ]) })));
    };
    // 09:30 JST selects tomorrow only, even when today's official feed is down.
    const result = await runScheduled({ DB: db }, Date.parse("2026-10-06T00:25:00Z"), mockFetch);
    assert.equal(result.status, "partial"); // ML persisted, AI has no configured key.
    assert.equal(result.targetCount, 1);
    assert.equal(result.successCount, 1);
    assert.equal(sqlite.prepare("SELECT count(DISTINCT service_id) AS count FROM ml_predictions").get()?.count, 1);
    assert.equal(sqlite.prepare("SELECT count(*) AS count FROM ai_predictions").get()?.count, 1);
    const run = sqlite.prepare("SELECT source_status FROM forecast_runs WHERE id=?").get(result.runId!);
    assert.equal(JSON.parse(String(run?.source_status)).schedule.status, "cached");
    assert.equal(JSON.parse(String(run?.source_status)).ai.unavailable,1);
    assert.equal(result.errorCount,2); // service AI and daily overview both unavailable
  } finally { sqlite.close(); }
});

test("midnight preparation recovers publication-day dates with actual preparation timestamps", async () => {
  const { db, sqlite } = database();
  try {
    const started = new Date("2026-10-06T23:55:00+09:00");
    const published = new Date("2026-10-07T00:00:00+09:00");
    await ensureForecastSchedule(db, provider(), started, published);
    assert.deepEqual(sqlite.prepare("SELECT service_date FROM services ORDER BY service_date").all().map(row => row.service_date),
      ["2026-10-07", "2026-10-08", "2026-10-09", "2026-10-10", "2026-10-11"]);
    assert.ok(sqlite.prepare("SELECT synced_at FROM schedule_syncs").all().every(row => row.synced_at === started.toISOString()));
  } finally { sqlite.close(); }
});
