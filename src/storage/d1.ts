import type { ServiceInput } from "../types.js";
import type { AssessmentResult } from "../pipeline/assessment.js";
import type { ServiceForecastSeries } from "../forecast/service-series.js";
import type { OfficialServiceStatus } from "../schedule/official-status.js";

export interface StoredServiceRow {
  id: string;
  service_date: string;
  service_number: string;
  ship_type: "jet" | "large";
  origin: string;
  destination: string;
  counterpart_terminal: string;
  scheduled_departure: string;
  scheduled_arrival: string;
}

export function twoHourRunSlot(date: Date): string {
  const slot = new Date(date);
  slot.setUTCMinutes(0, 0, 0);
  slot.setUTCHours(Math.floor(slot.getUTCHours() / 2) * 2);
  return slot.toISOString();
}

export async function acquireRun(db: D1Database, now: Date): Promise<{ id: string; slot: string } | null> {
  const id = crypto.randomUUID();
  const slot = twoHourRunSlot(now);
  const result = await db.prepare(`INSERT OR IGNORE INTO forecast_runs
    (id, run_slot, run_at, status, source_status, created_at) VALUES (?, ?, ?, 'running', '{}', ?)`).bind(id, slot, now.toISOString(), now.toISOString()).run();
  return result.meta.changes === 1 ? { id, slot } : null;
}

export async function upcomingServices(db: D1Database, now: Date, horizonDays = 4): Promise<ServiceInput[]> {
  const until = new Date(now.getTime() + horizonDays * 86_400_000).toISOString();
  const rows = await db.prepare(`SELECT id, service_number, ship_type, origin, destination, counterpart_terminal,
    scheduled_departure, scheduled_arrival FROM services
    WHERE actual_result_confirmed = 0 AND datetime(scheduled_departure) > datetime(?) AND datetime(scheduled_departure) <= datetime(?)
    ORDER BY scheduled_departure`).bind(now.toISOString(), until).all<StoredServiceRow>();
  return rows.results.map((row) => ({
    serviceId: row.id,
    voyageNumber: row.service_number,
    shipType: row.ship_type,
    direction: row.destination === "大島" ? "to_oshima" : "from_oshima",
    counterpartTerminal: row.counterpart_terminal,
    scheduledDepartureJst: row.scheduled_departure,
    scheduledArrivalJst: row.scheduled_arrival
  }));
}

export async function saveAssessment(db: D1Database, runId: string, serviceId: string, result: AssessmentResult, createdAt: string): Promise<void> {
  const statements = result.ml.predictions.map((prediction: { cancellationProbability: number; weatherModel: string; marineModel: string }) =>
    db.prepare(`INSERT INTO ml_predictions (id, forecast_run_id, service_id, cancellation_probability,
      operation_probability, model_version, features_version, weather_model, marine_model, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(crypto.randomUUID(), runId, serviceId,
      prediction.cancellationProbability, 1 - prediction.cancellationProbability, "v1-127", "v1-127",
      prediction.weatherModel, prediction.marineModel, createdAt)
  );
  const ai = result.ai;
  statements.push(db.prepare(`INSERT INTO ai_predictions (id, forecast_run_id, service_id, operation_probability,
    confidence, assessment, positive_factors_json, negative_factors_json, confidence_reasons_json, port_prediction,
    summary, forecast_summary_json, ai_status, error_message, gemini_model, prompt_version, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
      crypto.randomUUID(), runId, serviceId, ai?.operation_probability ?? null, ai?.confidence ?? null,
      ai?.assessment ?? null, JSON.stringify(ai?.positive_factors ?? []), JSON.stringify(ai?.negative_factors ?? []),
      JSON.stringify(ai?.confidence_reasons ?? []), ai?.port_prediction ?? null, ai?.summary ?? null,
      result.forecastSummary ? JSON.stringify(result.forecastSummary) : null, result.aiStatus,
      result.error ?? null, result.geminiModels?.final ?? null, result.promptVersion ?? null, createdAt
    ));
  await db.batch(statements);
}

export async function saveForecastSeries(db: D1Database, runId: string, serviceId: string, series: ServiceForecastSeries, createdAt: string): Promise<void> {
  await db.batch([
    db.prepare(`INSERT OR REPLACE INTO service_forecast_series (forecast_run_id, service_id, payload_json, created_at)
      VALUES (?, ?, ?, ?)`).bind(runId, serviceId, JSON.stringify(series), createdAt),
    db.prepare("DELETE FROM service_forecast_series WHERE created_at < datetime(?, '-30 days')").bind(createdAt)
  ]);
}

export async function readForecastSeries(db: D1Database, serviceId: string): Promise<{ forecastRunId: string; createdAt: string; series: ServiceForecastSeries } | null> {
  const row = await db.prepare(`SELECT forecast_run_id, payload_json, created_at FROM service_forecast_series
    WHERE service_id = ? ORDER BY created_at DESC LIMIT 1`).bind(serviceId).first<{ forecast_run_id: string; payload_json: string; created_at: string }>();
  return row ? { forecastRunId: row.forecast_run_id, createdAt: row.created_at, series: JSON.parse(row.payload_json) as ServiceForecastSeries } : null;
}

export async function saveOfficialStatuses(db: D1Database, statuses: OfficialServiceStatus[], observedAt: string, officialSource: string): Promise<number> {
  if (!statuses.length) return 0;
  const results = await db.batch(statuses.map((item) => db.prepare(`INSERT INTO official_service_statuses
    (service_id, status, port, note, source_updated_at, observed_at, official_source)
    SELECT s.id, ?, ?, ?, ?, ?, ? FROM services s
    WHERE s.service_date = ? AND s.service_number = ?
      AND ((? = 'to_oshima' AND s.destination = '大島') OR (? = 'from_oshima' AND s.origin = '大島'))
    ON CONFLICT(service_id) DO UPDATE SET status=excluded.status, port=excluded.port, note=excluded.note,
      source_updated_at=excluded.source_updated_at, observed_at=excluded.observed_at, official_source=excluded.official_source`).bind(
        item.status, item.port, item.note, item.sourceUpdatedAt, observedAt, officialSource,
        item.serviceDate, item.serviceNumber, item.direction, item.direction
      )));
  return results.reduce((count, result) => count + (result.meta.changes ?? 0), 0);
}

interface PredictionViewRow {
  service_id: string;
  service_date: string;
  service_number: string;
  ship_type: string;
  origin: string;
  destination: string;
  scheduled_departure: string;
  scheduled_arrival: string;
  operation_probability: number | null;
  confidence: number | null;
  assessment: string | null;
  port_prediction: string | null;
  summary: string | null;
  ai_status: string | null;
  prediction_created_at: string | null;
  ml_operation_probability: number | null;
  official_status: string | null;
  official_port: string | null;
  official_note: string | null;
  official_source_updated_at: string | null;
  official_source: string | null;
}

const LATEST_PREDICTION_SELECT = `SELECT s.id AS service_id, s.service_date, s.service_number, s.ship_type,
  s.origin, s.destination, s.scheduled_departure, s.scheduled_arrival, a.operation_probability, a.confidence,
  a.assessment, a.port_prediction, a.summary, a.ai_status, a.created_at AS prediction_created_at,
  os.status AS official_status, os.port AS official_port, os.note AS official_note,
  os.source_updated_at AS official_source_updated_at, os.official_source,
  (SELECT AVG(m.operation_probability) FROM ml_predictions m
    WHERE m.forecast_run_id = a.forecast_run_id AND m.service_id = s.id) AS ml_operation_probability
  FROM services s LEFT JOIN ai_predictions a ON a.id = (
    SELECT ap.id FROM ai_predictions ap WHERE ap.service_id = s.id ORDER BY ap.created_at DESC LIMIT 1
  ) LEFT JOIN official_service_statuses os ON os.service_id = s.id`;

export async function readDays(db: D1Database, fromDate: string, days = 5): Promise<Array<{ date: string; services: PredictionViewRow[] }>> {
  const end = new Date(`${fromDate}T00:00:00+09:00`);
  end.setDate(end.getDate() + days);
  const endDate = end.toISOString().slice(0, 10);
  const rows = await db.prepare(`${LATEST_PREDICTION_SELECT} WHERE s.service_date >= ? AND s.service_date < ? ORDER BY s.scheduled_departure`).bind(fromDate, endDate).all<PredictionViewRow>();
  const grouped = new Map<string, PredictionViewRow[]>();
  for (const row of rows.results) grouped.set(row.service_date, [...(grouped.get(row.service_date) ?? []), row]);
  return [...grouped].map(([date, services]) => ({ date, services }));
}

export async function readService(db: D1Database, serviceId: string): Promise<unknown | null> {
  const service = await db.prepare(`${LATEST_PREDICTION_SELECT} WHERE s.id = ?`).bind(serviceId).first<PredictionViewRow>();
  if (!service) return null;
  const predictions = await db.prepare(`SELECT operation_probability, confidence, port_prediction, created_at
    FROM ai_predictions WHERE service_id = ? ORDER BY created_at DESC LIMIT 2`).bind(serviceId).all<{
      operation_probability: number | null; confidence: number | null; port_prediction: string | null; created_at: string;
    }>();
  const current = predictions.results[0];
  const previous = predictions.results[1];
  return {
    ...service,
    previous_prediction: previous ?? null,
    change: current && previous ? {
      operation_probability_points: current.operation_probability !== null && previous.operation_probability !== null ? current.operation_probability - previous.operation_probability : null,
      confidence_points: current.confidence !== null && previous.confidence !== null ? current.confidence - previous.confidence : null,
      port_changed: current.port_prediction !== previous.port_prediction
    } : null
  };
}

export async function readHistory(db: D1Database, serviceId: string): Promise<unknown[]> {
  const rows = await db.prepare(`SELECT a.*, r.run_at,
    (SELECT json_group_array(json_object('weatherModel', m.weather_model, 'marineModel', m.marine_model,
      'cancellationProbability', m.cancellation_probability, 'operationProbability', m.operation_probability))
      FROM ml_predictions m WHERE m.forecast_run_id = a.forecast_run_id AND m.service_id = a.service_id) AS ml_predictions_json
    FROM ai_predictions a JOIN forecast_runs r ON r.id = a.forecast_run_id
    WHERE a.service_id = ? ORDER BY a.created_at DESC`).bind(serviceId).all<Record<string, unknown>>();
  return rows.results.map((row) => ({
    ...row,
    positive_factors: JSON.parse(String(row.positive_factors_json)),
    negative_factors: JSON.parse(String(row.negative_factors_json)),
    confidence_reasons: JSON.parse(String(row.confidence_reasons_json)),
    forecast_summary: row.forecast_summary_json ? JSON.parse(String(row.forecast_summary_json)) : null,
    ml_predictions: JSON.parse(String(row.ml_predictions_json)),
    positive_factors_json: undefined,
    negative_factors_json: undefined,
    confidence_reasons_json: undefined,
    forecast_summary_json: undefined,
    ml_predictions_json: undefined
  }));
}

export async function finishRun(db: D1Database, runId: string, startedAt: number, targetCount: number, successCount: number, errorCount: number, sourceStatus: unknown): Promise<void> {
  const status = errorCount === 0 ? "completed" : successCount > 0 ? "partial" : "failed";
  await db.prepare(`UPDATE forecast_runs SET status = ?, source_status = ?, target_count = ?, success_count = ?,
    error_count = ?, duration_ms = ?, completed_at = ? WHERE id = ?`).bind(status, JSON.stringify(sourceStatus), targetCount,
    successCount, errorCount, Date.now() - startedAt, new Date().toISOString(), runId).run();
}

export async function logRun(db: D1Database, runId: string, level: "info" | "warn" | "error", event: string, serviceId?: string, message?: string): Promise<void> {
  await db.prepare(`INSERT INTO run_logs (forecast_run_id, level, event, service_id, message, created_at)
    VALUES (?, ?, ?, ?, ?, ?)`).bind(runId, level, event, serviceId ?? null, message ?? null, new Date().toISOString()).run();
}
