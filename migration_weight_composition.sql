-- Die "Health Sync Gewicht"-CSV liefert neben Gewicht auch Körperfett- und
-- Skelettmuskelanteil (beides bereits als Prozentwert, keine Umrechnung von kg
-- nötig). Spalten ergänzen, damit sync.js sie mitschreiben kann.
-- Ausführen mit: npx wrangler d1 execute health-tracker --remote --file=migration_weight_composition.sql

ALTER TABLE sync_weight_readings ADD COLUMN body_fat_pct REAL;
ALTER TABLE sync_weight_readings ADD COLUMN muscle_pct REAL;
