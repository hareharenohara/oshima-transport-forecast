CREATE TABLE official_service_statuses (
  service_id TEXT PRIMARY KEY REFERENCES services(id),
  status TEXT NOT NULL,
  port TEXT,
  note TEXT,
  source_updated_at TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  official_source TEXT NOT NULL
);

CREATE INDEX official_service_statuses_observed_idx ON official_service_statuses(observed_at DESC);
