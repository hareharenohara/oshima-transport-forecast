CREATE TABLE IF NOT EXISTS daily_forecasts (
  forecast_run_id TEXT NOT NULL REFERENCES forecast_runs(id),
  service_date TEXT NOT NULL,
  assessment_json TEXT,
  ai_status TEXT NOT NULL,
  error_message TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (forecast_run_id, service_date)
);
CREATE INDEX IF NOT EXISTS idx_daily_forecasts_date ON daily_forecasts(service_date, forecast_run_id);
