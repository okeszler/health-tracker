-- Health Sync v3: bereinigt die durch Backfill-Dateien doppelt gezählten
-- Schritte/Puls/Schlaf/Gewicht-Messungen. Der Import-Code schreibt jetzt pro Datei
-- "ersetzend" (löscht zuerst alle Messungen für die in der Datei vorkommenden Tage),
-- damit sich überschneidende Tages- und Backfill-Exporte sich nicht mehr aufaddieren.
-- Alle bisher verarbeiteten Dateien werden erneut zugelassen, damit der nächste
-- Sync die Historie mit der neuen, korrekten Logik komplett neu aufbaut.
--
-- Ausführen mit: npx wrangler d1 execute health-tracker --remote --file=migration_sync_v3.sql

DELETE FROM sync_steps_readings;
DELETE FROM sync_pulse_readings;
DELETE FROM sync_sleep_readings;
DELETE FROM sync_weight_readings;
DELETE FROM sync_files WHERE category IN ('puls', 'schritte', 'schlaf', 'gewicht');
