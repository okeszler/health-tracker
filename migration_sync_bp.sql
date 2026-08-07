-- Health Sync: Blutdruck-Ordner kam nachträglich dazu (Samsung Health).
-- Ausführen mit: npx wrangler d1 execute health-tracker --remote --file=migration_sync_bp.sql

-- Einzelmessungen (nicht aggregiert, da mehrere Messungen pro Tag möglich sind).
-- UNIQUE + INSERT OR IGNORE, weil die Health-Sync-Exportdateien für Blutdruck sich
-- überlappen können (dieselbe Messung taucht in mehreren Monats-/Wochen-Dateien auf).
CREATE TABLE IF NOT EXISTS sync_bp_readings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_date TEXT NOT NULL,
  reading_time TEXT,
  systolic REAL,
  diastolic REAL,
  pulse REAL,
  note TEXT,
  UNIQUE(entry_date, reading_time, systolic, diastolic)
);

CREATE INDEX IF NOT EXISTS idx_sync_bp_date ON sync_bp_readings(entry_date);
