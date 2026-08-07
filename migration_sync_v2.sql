-- Health Sync v2: Rohmessungen statt akkumulierter Tagessummen.
--
-- Grund: Health Sync ersetzt seine Tagesdateien (Schritte/Puls/Schlaf) offenbar
-- periodisch komplett durch eine neue Datei mit neuer Drive-ID statt nur neue
-- Minuten anzuhängen. Das alte Modell ("bei jeder neu gesehenen Datei draufaddieren")
-- zählt dadurch denselben Tag mehrfach. Die neue Lösung speichert jede Einzelmessung
-- (dedupliziert über UNIQUE + INSERT OR IGNORE, wie schon bei Blutdruck/Aktivitäten)
-- und aggregiert Tageswerte erst beim Lesen per SQL -- Mehrfach-Importe derselben
-- Messung sind dadurch automatisch harmlos, unabhängig davon wie Health Sync exportiert.
--
-- Ausführen mit: npx wrangler d1 execute health-tracker --remote --file=migration_sync_v2.sql

CREATE TABLE IF NOT EXISTS sync_steps_readings (
  entry_date TEXT NOT NULL,
  reading_time TEXT NOT NULL,
  steps INTEGER NOT NULL,
  UNIQUE(entry_date, reading_time, steps)
);
CREATE INDEX IF NOT EXISTS idx_sync_steps_readings_date ON sync_steps_readings(entry_date);

CREATE TABLE IF NOT EXISTS sync_pulse_readings (
  entry_date TEXT NOT NULL,
  reading_time TEXT NOT NULL,
  bpm INTEGER NOT NULL,
  UNIQUE(entry_date, reading_time, bpm)
);
CREATE INDEX IF NOT EXISTS idx_sync_pulse_readings_date ON sync_pulse_readings(entry_date);

CREATE TABLE IF NOT EXISTS sync_sleep_readings (
  entry_date TEXT NOT NULL,
  reading_time TEXT NOT NULL,
  duration_seconds INTEGER NOT NULL,
  stage TEXT,
  UNIQUE(entry_date, reading_time, duration_seconds, stage)
);
CREATE INDEX IF NOT EXISTS idx_sync_sleep_readings_date ON sync_sleep_readings(entry_date);

CREATE TABLE IF NOT EXISTS sync_weight_readings (
  entry_date TEXT NOT NULL,
  reading_time TEXT NOT NULL,
  weight_kg REAL NOT NULL,
  UNIQUE(entry_date, reading_time, weight_kg)
);
CREATE INDEX IF NOT EXISTS idx_sync_weight_readings_date ON sync_weight_readings(entry_date);

-- alte, fehleranfällige Aggregat-Tabellen weg -- Aggregation passiert jetzt live
-- beim Lesen (siehe functions/api/sync-data.js)
DROP TABLE IF EXISTS sync_steps_daily;
DROP TABLE IF EXISTS sync_pulse_daily;
DROP TABLE IF EXISTS sync_sleep_daily;
DROP TABLE IF EXISTS sync_weight_daily;

-- alle bisher verarbeiteten Dateien für die betroffenen Kategorien erneut zulassen,
-- damit ihr Inhalt in die neuen Rohdaten-Tabellen einfließt
DELETE FROM sync_files WHERE category IN ('puls', 'schritte', 'schlaf', 'gewicht');
