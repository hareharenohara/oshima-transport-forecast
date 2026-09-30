ALTER TABLE services ADD COLUMN schedule_active INTEGER NOT NULL DEFAULT 1 CHECK (schedule_active IN (0, 1));
CREATE INDEX IF NOT EXISTS idx_services_active_date ON services (schedule_active, service_date, scheduled_departure);
