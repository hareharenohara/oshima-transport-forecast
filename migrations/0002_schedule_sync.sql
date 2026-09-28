ALTER TABLE services ADD COLUMN source_url TEXT;
ALTER TABLE services ADD COLUMN source_version TEXT;

CREATE TABLE schedule_syncs (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  source_url TEXT NOT NULL,
  source_version TEXT NOT NULL,
  range_start TEXT NOT NULL,
  range_end TEXT NOT NULL,
  service_count INTEGER NOT NULL,
  synced_at TEXT NOT NULL
);
