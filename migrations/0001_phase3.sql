PRAGMA foreign_keys = ON;

CREATE TABLE services (
  id TEXT PRIMARY KEY,
  service_date TEXT NOT NULL,
  service_number TEXT NOT NULL,
  ship_type TEXT NOT NULL CHECK (ship_type IN ('jet', 'large')),
  origin TEXT NOT NULL,
  destination TEXT NOT NULL,
  counterpart_terminal TEXT NOT NULL,
  scheduled_departure TEXT NOT NULL,
  scheduled_arrival TEXT NOT NULL,
  scheduled_duration_minutes INTEGER NOT NULL CHECK (scheduled_duration_minutes > 0),
  actual_result_confirmed INTEGER NOT NULL DEFAULT 0 CHECK (actual_result_confirmed IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX services_upcoming_idx ON services(actual_result_confirmed, scheduled_departure);

CREATE TABLE forecast_runs (
  id TEXT PRIMARY KEY,
  run_slot TEXT NOT NULL UNIQUE,
  run_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'partial', 'failed')),
  source_status TEXT NOT NULL DEFAULT '{}',
  target_count INTEGER NOT NULL DEFAULT 0,
  success_count INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER,
  created_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE ml_predictions (
  id TEXT PRIMARY KEY,
  forecast_run_id TEXT NOT NULL REFERENCES forecast_runs(id),
  service_id TEXT NOT NULL REFERENCES services(id),
  cancellation_probability REAL NOT NULL CHECK (cancellation_probability BETWEEN 0 AND 1),
  operation_probability REAL NOT NULL CHECK (operation_probability BETWEEN 0 AND 1),
  model_version TEXT NOT NULL,
  features_version TEXT NOT NULL,
  weather_model TEXT NOT NULL,
  marine_model TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(forecast_run_id, service_id, weather_model, marine_model)
);

CREATE INDEX ml_predictions_service_idx ON ml_predictions(service_id, created_at DESC);

CREATE TABLE ai_predictions (
  id TEXT PRIMARY KEY,
  forecast_run_id TEXT NOT NULL REFERENCES forecast_runs(id),
  service_id TEXT NOT NULL REFERENCES services(id),
  operation_probability INTEGER CHECK (operation_probability BETWEEN 0 AND 100),
  confidence INTEGER CHECK (confidence BETWEEN 0 AND 100),
  assessment TEXT,
  positive_factors_json TEXT NOT NULL DEFAULT '[]',
  negative_factors_json TEXT NOT NULL DEFAULT '[]',
  confidence_reasons_json TEXT NOT NULL DEFAULT '[]',
  port_prediction TEXT CHECK (port_prediction IN ('元町', '岡田', '不明')),
  summary TEXT,
  forecast_summary_json TEXT,
  ai_status TEXT NOT NULL CHECK (ai_status IN ('generated', 'unavailable')),
  error_message TEXT,
  gemini_model TEXT,
  prompt_version TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(forecast_run_id, service_id)
);

CREATE INDEX ai_predictions_service_idx ON ai_predictions(service_id, created_at DESC);

CREATE TABLE actual_results (
  service_id TEXT PRIMARY KEY REFERENCES services(id),
  result TEXT NOT NULL,
  cancellation_reason TEXT,
  departure_port TEXT,
  arrival_port TEXT,
  official_source TEXT NOT NULL,
  confirmed_at TEXT NOT NULL
);

CREATE TABLE run_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  forecast_run_id TEXT REFERENCES forecast_runs(id),
  level TEXT NOT NULL CHECK (level IN ('info', 'warn', 'error')),
  event TEXT NOT NULL,
  service_id TEXT,
  message TEXT,
  details_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE INDEX run_logs_run_idx ON run_logs(forecast_run_id, created_at);
