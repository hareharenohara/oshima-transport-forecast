CREATE TABLE IF NOT EXISTS group_forecasts (
  forecast_run_id TEXT NOT NULL REFERENCES forecast_runs(id),
  group_id TEXT NOT NULL,
  service_date TEXT NOT NULL,
  horizon_days INTEGER NOT NULL CHECK (horizon_days BETWEEN 2 AND 4),
  label TEXT NOT NULL,
  ship_type TEXT NOT NULL,
  member_ids_json TEXT NOT NULL,
  assessment_json TEXT,
  ai_status TEXT NOT NULL,
  error_message TEXT,
  model TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (forecast_run_id, group_id)
);
CREATE INDEX IF NOT EXISTS idx_group_forecasts_date ON group_forecasts(service_date, forecast_run_id);
