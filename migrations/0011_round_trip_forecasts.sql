ALTER TABLE services ADD COLUMN round_trip_id TEXT;
ALTER TABLE services ADD COLUMN paired_service_id TEXT;
CREATE INDEX services_round_trip_idx ON services(round_trip_id);
ALTER TABLE ai_predictions ADD COLUMN pairing_version TEXT;
