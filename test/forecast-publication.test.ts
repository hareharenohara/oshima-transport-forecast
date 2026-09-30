import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { claimDuePushRuns, readDays, readForecastSeries, readHistory, readLatestPublishedRunSlot, readLatestPublicationTime, readService } from "../src/storage/d1.js";

test("staged forecasts stay private and appear after their publication time, including late completion", async () => {
  const sqlite = new DatabaseSync(":memory:");
  try {
    const names = ["phase3", "schedule_sync", "phase5_push", "forecast_series", "official_service_status",
      "gemini_model_audit", "grounded_ai_reasoning", "ai_provider_audit", "ai_ordinal_assessment",
      "ai_sabcd_rating", "round_trip_forecasts", "correct_early_october_schedule", "official_schedule_active", "forecast_publication"];
    for (const [index, name] of names.entries()) {
      sqlite.exec(readFileSync(new URL(`../../migrations/${String(index + 1).padStart(4, "0")}_${name}.sql`, import.meta.url), "utf8"));
    }
    sqlite.exec(`INSERT INTO services (id,service_date,service_number,ship_type,origin,destination,counterpart_terminal,scheduled_departure,scheduled_arrival,scheduled_duration_minutes,created_at,updated_at)
      VALUES ('service','2026-09-30','1220','jet','東京','大島','東京','2026-09-30T08:35:00+09:00','2026-09-30T10:20:00+09:00',105,'old','old');
      INSERT INTO forecast_runs (id,run_slot,run_at,status,created_at,completed_at,publish_at)
      VALUES ('old','2026-09-30T03:00:00.000Z','old','completed','old','old',NULL),
             ('new','2026-09-30T05:00:00.000Z','new','running','new',NULL,'9999-01-01T00:00:00.000Z');
      INSERT INTO ai_predictions (id,forecast_run_id,service_id,evaluation_rating,ai_status,created_at)
      VALUES ('old-ai','old','service','A','generated','2026-09-30T03:10:00Z'),('new-ai','new','service','C','generated','2026-09-30T04:55:00Z');
      INSERT INTO service_forecast_series (forecast_run_id,service_id,payload_json,created_at)
      VALUES ('old','service','{"version":"old"}','2026-09-30T03:10:00Z'),('new','service','{"version":"new"}','2026-09-30T04:55:00Z');`);
    const db = { prepare(query: string) { const statement = sqlite.prepare(query); return {
      bind(...values: unknown[]) { return {
        all: async () => ({ results: statement.all(...values as []) }),
        first: async () => statement.get(...values as []) ?? null,
        run: async () => ({ meta: { changes: statement.run(...values as []).changes } })
      }; },
      first: async () => statement.get() ?? null
    }; } } as unknown as D1Database;
    const grade = async () => (await readDays(db, "2026-09-30", 1))[0]?.services[0]?.evaluation_grade;
    assert.equal(await grade(), "A");
    assert.equal((await readService(db, "service") as { evaluation_grade: string }).evaluation_grade, "A");
    assert.equal((await readHistory(db, "service")).length, 1);
    assert.equal((await readForecastSeries(db, "service"))?.forecastRunId, "old");
    assert.equal(await readLatestPublishedRunSlot(db), "2026-09-30T03:00:00.000Z");
    assert.deepEqual(await claimDuePushRuns(db, new Date()), []);
    sqlite.exec("UPDATE forecast_runs SET status='completed',completed_at='new' WHERE id='new'");
    assert.equal(await grade(), "A");
    assert.deepEqual(await claimDuePushRuns(db, new Date()), []);
    sqlite.exec("UPDATE forecast_runs SET publish_at='2000-01-01T00:00:00.000Z' WHERE id='new'");
    assert.equal(await grade(), "C");
    assert.equal((await readHistory(db, "service")).length, 2);
    assert.equal((await readForecastSeries(db, "service"))?.forecastRunId, "new");
    assert.equal(await readLatestPublishedRunSlot(db), "2026-09-30T05:00:00.000Z");
    assert.deepEqual(await claimDuePushRuns(db, new Date()), ["new"]);
    assert.deepEqual(await claimDuePushRuns(db, new Date()), []);
    // Completed in advance: show the publication boundary, not prediction creation.
    sqlite.exec("UPDATE forecast_runs SET publish_at='2000-01-01T05:00:00.000Z',completed_at='2000-01-01T04:54:00Z' WHERE id='new'");
    assert.equal(await readLatestPublicationTime(db), "2000-01-01T05:00:00.000Z");
    assert.equal((await readService(db, "service") as { prediction_published_at: string }).prediction_published_at, "2000-01-01T05:00:00.000Z");
    assert.equal((await readHistory(db, "service") as Array<{ published_at: string }>)[0]?.published_at, "2000-01-01T05:00:00.000Z");
    // Late completion becomes public then; never report the missed scheduled time.
    sqlite.exec("UPDATE forecast_runs SET completed_at='2000-01-01T05:07:00Z' WHERE id='new'");
    assert.equal(await readLatestPublicationTime(db), "2000-01-01T05:07:00Z");
    assert.equal((await readService(db, "service") as { prediction_published_at: string }).prediction_published_at, "2000-01-01T05:07:00Z");
  } finally { sqlite.close(); }
});
