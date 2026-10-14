CREATE TABLE flight_notification_settings (
  subscription_id TEXT PRIMARY KEY REFERENCES push_subscriptions(id) ON DELETE CASCADE,
  preferences_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE watched_services (
  subscription_id TEXT NOT NULL REFERENCES push_subscriptions(id) ON DELETE CASCADE,
  service_id TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  snapshot_json TEXT NOT NULL,
  claim_token TEXT,
  claim_until TEXT,
  PRIMARY KEY (subscription_id, service_id)
);
