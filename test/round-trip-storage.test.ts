import test from "node:test";
import assert from "node:assert/strict";
import { readDays } from "../src/storage/d1.js";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";

test("each departure date keeps its own one-way grade and inactive rows stay hidden", async () => {
  const sqlite = new DatabaseSync(":memory:");
  try {
    for (let index = 1; index <= 11; index++) {
      const name = `${String(index).padStart(4, "0")}_${[
        "phase3", "schedule_sync", "phase5_push", "forecast_series", "official_service_status",
        "gemini_model_audit", "grounded_ai_reasoning", "ai_provider_audit", "ai_ordinal_assessment",
        "ai_sabcd_rating", "round_trip_forecasts"
      ][index - 1]}.sql`;
      sqlite.exec(readFileSync(new URL(`../../migrations/${name}`, import.meta.url), "utf8"));
    }
    sqlite.exec(readFileSync(new URL("../../migrations/0013_official_schedule_active.sql", import.meta.url), "utf8"));
    sqlite.exec(readFileSync(new URL("../../migrations/0014_forecast_publication.sql", import.meta.url), "utf8"));
    sqlite.exec(`INSERT INTO services (id,service_date,service_number,ship_type,origin,destination,counterpart_terminal,scheduled_departure,scheduled_arrival,scheduled_duration_minutes,created_at,updated_at,round_trip_id,paired_service_id)
      VALUES ('out','2026-09-30','3000','large','東京','大島','東京','2026-09-30T22:00:00+09:00','2026-10-01T06:00:00+09:00',480,'now','now','out','back'),
             ('back','2026-10-01','2000','large','大島','東京','東京','2026-10-01T14:30:00+09:00','2026-10-01T19:00:00+09:00',270,'now','now','out','out');
      INSERT INTO forecast_runs (id,run_slot,run_at,status,created_at) VALUES ('run','2026-09-30T00:00:00Z','2026-09-30T00:00:00Z','completed','now');
      INSERT INTO ai_predictions (id,forecast_run_id,service_id,evaluation_rating,ai_status,created_at,pairing_version)
      VALUES ('out-ai','run','out','C','generated','now','round-trip-v1'),
             ('back-ai','run','back','A','generated','now','round-trip-v1');
      INSERT INTO official_service_statuses (service_id,status,source_updated_at,observed_at,official_source)
      VALUES ('out','出航','now','now','official'),('back','天候調査中','now','now','official');`);
    const db = { prepare(query: string) { const statement = sqlite.prepare(query); return {
      bind(...values: unknown[]) { return { all: async () => ({ results: statement.all(...values as []) }) }; }
    }; } } as unknown as D1Database;
    const days = await readDays(db, "2026-09-30", 2);
    assert.deepEqual(days.map((day) => [day.date, day.services[0]?.evaluation_grade]), [
      ["2026-09-30", "C"], ["2026-10-01", "A"]
    ]);
    assert.equal(days[1]?.services[0]?.leg_evaluation_grade, "A");
    assert.equal(days[0]?.services[0]?.paired_official_status, "天候調査中");
    sqlite.exec("UPDATE ai_predictions SET pairing_version=NULL");
    const retained = await readDays(db, "2026-09-30", 2);
    assert.equal(retained[1]?.services[0]?.evaluation_grade, "A");
    sqlite.exec("DELETE FROM ai_predictions WHERE service_id='out'");
    const incomplete = await readDays(db, "2026-09-30", 2);
    assert.equal(incomplete[1]?.services[0]?.evaluation_grade, "A");
    sqlite.exec("UPDATE services SET schedule_active=0 WHERE id='back'");
    const active = await readDays(db, "2026-09-30", 2);
    assert.deepEqual(active.map((day) => day.date), ["2026-09-30"]);
  } finally { sqlite.close(); }
});
