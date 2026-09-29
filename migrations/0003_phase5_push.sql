CREATE TABLE push_subscriptions (
  id TEXT PRIMARY KEY,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE user_notification_preferences (
  subscription_id TEXT PRIMARY KEY REFERENCES push_subscriptions(id) ON DELETE CASCADE,
  route_group TEXT NOT NULL DEFAULT 'all' CHECK (route_group IN ('all', 'tokyo', 'atami', 'other')),
  probability_threshold INTEGER CHECK (probability_threshold IN (30, 50)),
  change_threshold INTEGER CHECK (change_threshold IS NULL OR change_threshold >= 1),
  notify_risk_transition INTEGER NOT NULL DEFAULT 1 CHECK (notify_risk_transition IN (0, 1)),
  notify_port_change INTEGER NOT NULL DEFAULT 1 CHECK (notify_port_change IN (0, 1)),
  notify_official_update INTEGER NOT NULL DEFAULT 1 CHECK (notify_official_update IN (0, 1)),
  updated_at TEXT NOT NULL
);

CREATE TABLE notification_states (
  subscription_id TEXT NOT NULL REFERENCES push_subscriptions(id) ON DELETE CASCADE,
  service_id TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  event_key TEXT NOT NULL,
  last_notified_at TEXT NOT NULL,
  PRIMARY KEY (subscription_id, service_id, event_key)
);

CREATE INDEX push_subscriptions_updated_idx ON push_subscriptions(updated_at);
