-- NULL publication time preserves visibility of forecasts created before this rollout.
ALTER TABLE forecast_runs ADD COLUMN publish_at TEXT;
ALTER TABLE forecast_runs ADD COLUMN push_dispatched_at TEXT;
CREATE INDEX IF NOT EXISTS forecast_runs_due_publication_idx
  ON forecast_runs (publish_at, push_dispatched_at, status);
