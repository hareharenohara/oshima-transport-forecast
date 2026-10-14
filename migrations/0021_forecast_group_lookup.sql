-- Narrow successful-history fallback searches to the same group and member set.
CREATE INDEX IF NOT EXISTS idx_group_forecasts_members
  ON group_forecasts(group_id, member_ids_json, forecast_run_id);
