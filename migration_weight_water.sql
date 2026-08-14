-- "Gesamtkörperwasser" in der Health-Sync-Gewicht-CSV ist wie Skelettmuskelmasse
-- in kg angegeben (Samsung Health zeigt auch in der App kg an), nicht Prozent --
-- Spalte für den umgerechneten %-Wert ergänzen.
-- Ausführen mit: npx wrangler d1 execute health-tracker --remote --file=migration_weight_water.sql

ALTER TABLE sync_weight_readings ADD COLUMN body_water_pct REAL;
