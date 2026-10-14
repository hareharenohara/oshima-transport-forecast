CREATE TABLE site_admin_sessions (
  token_hash TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL,
  password_version TEXT NOT NULL,
  hostname TEXT NOT NULL
);
CREATE INDEX site_admin_sessions_expiry ON site_admin_sessions(expires_at);
CREATE TABLE site_admin_login_limits (
  bucket TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX site_admin_login_limits_expiry ON site_admin_login_limits(expires_at);
