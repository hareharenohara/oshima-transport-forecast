CREATE TABLE service_forecast_series (
  forecast_run_id TEXT NOT NULL REFERENCES forecast_runs(id),
  service_id TEXT NOT NULL REFERENCES services(id),
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (forecast_run_id, service_id)
);

CREATE INDEX service_forecast_series_service_idx ON service_forecast_series(service_id, created_at DESC);
CREATE INDEX service_forecast_series_created_idx ON service_forecast_series(created_at);
