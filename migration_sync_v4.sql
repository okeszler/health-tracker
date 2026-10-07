-- Health Sync v4: Schreibvorgänge sparen (D1 Free: 100.000 geschriebene Zeilen
-- pro Tag für das ganze Cloudflare-Konto).
--
-- 1. Die separaten Datums-Indizes sind überflüssig: der UNIQUE-Index jeder
--    Messungs-Tabelle beginnt bereits mit entry_date und deckt dieselben Abfragen
--    ab. Jeder Index kostet pro eingefügter/gelöschter Zeile einen zusätzlichen
--    Schreibvorgang -- ohne sie sinkt der Aufwand pro Messung von 3 auf 2.
-- 2. Neue Tabellen für den Tages-Fingerabdruck (nur geänderte Tage neu schreiben)
--    und das Sync-Tagesbudget. sync.js legt sie bei Bedarf auch selbst an.
--
-- Ausführen mit: npx wrangler d1 execute health-tracker --remote --file=migration_sync_v4.sql

DROP INDEX IF EXISTS idx_sync_steps_readings_date;
DROP INDEX IF EXISTS idx_sync_pulse_readings_date;
DROP INDEX IF EXISTS idx_sync_sleep_readings_date;
DROP INDEX IF EXISTS idx_sync_weight_readings_date;

CREATE TABLE IF NOT EXISTS sync_day_hashes (
  category TEXT NOT NULL,
  entry_date TEXT NOT NULL,
  hash TEXT NOT NULL,
  PRIMARY KEY (category, entry_date)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS sync_usage (
  day TEXT PRIMARY KEY,
  rows_written INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;
