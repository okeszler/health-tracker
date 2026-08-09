-- Rate-Limiting fürs Login: verhindert Brute-Force auf das App-Passwort.
-- Ausführen mit: npx wrangler d1 execute health-tracker --remote --file=migration_login_attempts.sql

CREATE TABLE IF NOT EXISTS login_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ip TEXT NOT NULL,
  attempted_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_login_attempts_ip_time ON login_attempts(ip, attempted_at);
