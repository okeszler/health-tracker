# Health Metrics Tracker

Cloudflare Pages + D1, gleiches Muster wie die anderen Cloudflare-Apps
(kratos-gymtracker, dagoberts-geldspeicher, ...).

Live: https://oliver-health-tracker.pages.dev

## Bereiche der App
Navigation über die Tab-Leiste (am Handy unten, am Desktop oben):
- **Übersicht** — aktuelle Werte (Gewicht, Körperfett, Muskel, Körperwasser, Blutdruck mit
  Ampel nach ESC/ESH-Einstufung, Ruhepuls), Trend der letzten 7 Tage vs. Vorwoche, Aktualität
  der Health-Sync-Daten, Ziele
- **Erfassen** — Vitals bzw. Blutwerte eintragen (umschaltbar), jeweils mit Log zum
  Bearbeiten/Löschen
- **Verlauf** — alle Charts auf echter Zeitachse, Zeitraum 30 Tage / 90 Tage / 1 Jahr / Alles
- **Aktivität** — Health Sync (manuell + automatisch), Schritte mit 7-Tage-Schnitt,
  Schlaf-Zeitstrahl, Aktivitäten-Log

Menü (⋯ oben rechts): Vitals/Blutwerte als CSV exportieren (Excel-tauglich), Abmelden.
Hell/Dunkel folgt automatisch dem Gerät; der Button daneben setzt eine feste Wahl.

## Struktur
- `public/index.html` — komplettes Frontend (Seiten, Formulare, Charts, Logs)
- `public/sw.js` — Service Worker (Installieren als App, Offline-Fallback der App-Shell)
- `public/manifest.json`, `public/favicon.ico`, `public/icons/` — App-Icons/Favicon
- `functions/_middleware.js` — PIN-/Passwortschutz für die ganze App (siehe unten)
- `functions/api/export.js` — CSV-Export (Vitals, Blutwerte)
- `cron-worker/` — kleiner Worker, der den Health-Sync 2× täglich automatisch anstößt
- `functions/api/metrics.js` — CRUD für tägliche Vitals (Gewicht, Körperzusammensetzung, Blutdruck, Puls)
- `functions/api/labs.js` — CRUD für Laborwerte (freier Testname + Einheit, rückwirkend erfassbar)
- `functions/api/goals.js` — Zielwerte (Gewicht, Körperfett)
- `functions/api/sync.js`, `functions/api/sync-data.js`, `functions/api/_google.js` — Health-Sync-Import
  aus Google Drive (siehe unten)
- `schema.sql` — vollständiges D1-Schema: für eine neue Datenbank reicht diese eine Datei
- `migration_*.sql` — nur für ältere, bestehende Installationen (in `schema.sql` bereits enthalten):
- `migration_v2.sql` — nur nötig, falls du das ursprüngliche v1-Schema (mit Wasserzufuhr statt
  Blutwerten/Muskel%/Körperwasser%) schon deployed hattest
- `migration_sync.sql` — Tabellen für den Health-Sync-Import (Schritte/Puls/Schlaf/Aktivitäten/Gewicht)
- `migration_sync_bp.sql` — zusätzliche Tabelle für Health-Sync-Blutdruck (Samsung Health)
- `migration_sync_v2.sql` — stellt Schritte/Puls/Schlaf/Gewicht auf Einzelmessungen +
  Live-Aggregation um (Health Sync ersetzt Tagesdateien periodisch komplett statt nur
  neue Daten anzuhängen; das alte Akkumulations-Modell zählte dadurch doppelt)
- `migration_sync_v3.sql` — bereinigt Doppelzählungen durch überlappende Backfill-
  Exportdateien (z.B. "Schritte 2026.07.08-2026.08.07...csv"); der Import ersetzt
  jetzt pro Datei die betroffenen Tage komplett statt Messungen nur zu addieren
- `migration_login_attempts.sql` — Tabelle fürs Rate-Limiting beim Login (Brute-Force-Schutz)
- `migration_weight_composition.sql` — Körperfett-/Skelettmuskelanteil aus der
  Health-Sync-Gewicht-CSV zusätzlich zum Gewicht erfassen
- `migration_weight_water.sql` — Körperwasser (kg -> %) ebenfalls aus der
  Health-Sync-Gewicht-CSV erfassen; Fettmasse/Muskel/Körperwasser lassen sich
  jetzt auch manuell in kg eintragen (wie in Samsung Health angezeigt) und
  werden automatisch in % umgerechnet
- `wrangler.toml`, `package.json` — Konfiguration

## PIN-/Passwortschutz

Die App zeigt sensible Gesundheitsdaten, deshalb ist sie mit einem gemeinsamen
Passwort geschützt (Cookie-Login, 30 Tage gültig, kein Benutzerkonto nötig).
Besteht `APP_PASSWORD` nur aus Ziffern, zeigt die Login-Seite ein PIN-Tastenfeld, das
automatisch absendet, sobald alle Stellen eingetippt sind; sonst ein normales
Passwortfeld. Nach 8 Fehlversuchen in 15 Minuten wird die IP vorübergehend gesperrt.
Ohne gesetztes Passwort bleibt die App offen — für den ersten Deploy also am besten
gleich das Secret setzen (siehe Deploy-Schritte unten, "Passwort setzen").

## Deployen — Browser-Weg (kein Terminal nötig)

### 1 — GitHub-Repo anlegen
1. Auf https://github.com einloggen (Account erstellen, falls noch keiner da)
2. Oben rechts **+ → New repository**
3. Name z. B. `health-tracker`, **Private** auswählen, **Create repository**
4. Auf der leeren Repo-Seite: **uploading an existing file** anklicken
5. Den kompletten `health-tracker`-Ordner per Drag & Drop in das Upload-Feld
   ziehen (Chrome/Edge erlauben das Ziehen ganzer Ordner, Struktur bleibt erhalten)
6. Unten **Commit changes** klicken

### 2 — Cloudflare Pages mit dem Repo verbinden
1. Auf https://dash.cloudflare.com einloggen (Account erstellen, falls nötig)
2. **Workers & Pages → Create → Pages → Connect to Git**
3. Das gerade erstellte GitHub-Repo auswählen, Berechtigung erteilen
4. Build-Einstellungen: **Framework preset: None**, **Build output
   directory: `public`** (alles andere leer lassen), **Save and Deploy**

### 3 — D1-Datenbank anlegen
1. **Workers & Pages → D1 → Create database**, Name `health-tracker`
2. Im neuen Datenbank-Ansicht auf Tab **Console**
3. Den kompletten Inhalt von `schema.sql` reinkopieren, **Execute**

### 4 — D1-Bindung setzen
Pages-Projekt → **Settings → Functions → D1 database bindings → Add binding**
— Variable name `DB`, Datenbank `health-tracker`.

### 5 — Passwort setzen
Pages-Projekt → **Settings → Environment variables → Add variable**
— Name `APP_PASSWORD`, Typ **Secret**, Wert = dein gewünschtes Passwort, **Save**.

Danach im Tab **Deployments** das letzte Deployment über **Retry deployment**
neu anstoßen, damit D1-Bindung und Passwort greifen — fertig.

### Custom Domain (optional)
**Workers & Pages → Projekt → Custom domains → Add domain** — falls du
später doch eine eigene Domain statt `.pages.dev` willst (~10–15 €/Jahr).

---

## Deployen — Terminal-Weg (wrangler / Claude Code)

Voraussetzungen: Node.js installiert, ein Cloudflare-Account (kostenlos).

```powershell
npm install
npx wrangler login

# D1-Datenbank anlegen
npx wrangler d1 create health-tracker
# -> die ausgegebene database_id in wrangler.toml eintragen (PASTE_DATABASE_ID_HERE ersetzen)

# Schema einspielen
npm run db:init

# Passwort setzen (Secret)
npx wrangler pages secret put APP_PASSWORD --project-name=oliver-health-tracker

# Deployen
npm run deploy
```

Danach einmalig im Cloudflare-Dashboard unter Pages → health-tracker → Settings → Functions
das D1-Binding `DB` mit der eben angelegten Datenbank verknüpfen, falls das nicht schon
automatisch über `wrangler.toml` gegriffen hat. Danach nochmal `npm run deploy`, damit
Bindung und Passwort-Secret in der laufenden Deployment greifen.

## Laufender Betrieb
- **Code-Änderungen:** Dateien anpassen → `npm run deploy` (Terminal-Weg) oder Datei(en)
  im GitHub-Repo ersetzen (Browser-Weg, Cloudflare deployt bei jedem Push automatisch neu).
- **Passwort ändern:** Secret `APP_PASSWORD` im Dashboard neu setzen (oder erneut
  `wrangler pages secret put APP_PASSWORD`) und neu deployen.

## Falls du schon ein v1-Deployment hattest (mit Wasserzufuhr statt Blutwerten)

```powershell
npm run db:migrate
npm run deploy
```

## Health Sync (Schritte, Puls, Schlaf, Blutdruck, Aktivitäten) aus Google Drive

Die App (Health Sync) synct dein Handy periodisch als CSV-Dateien in Google-Drive-Ordner:
`Health Sync Puls`, `Health Sync Schritte`, `Health Sync Schlaf`, `Health Sync Aktivitäten`,
`Health Sync Gewicht`, `Health Sync Blutdruck`. `health-tracker` liest diese über ein Google
Service Account (read-only, kein OAuth-Login nötig) und aggregiert sie zu Tageswerten (Blutdruck
und Aktivitäten bleiben Einzelmessungen, da mehrere pro Tag möglich sind). Legt Health Sync
später weitere Ordner an, einfach in `functions/api/sync.js` bei `CATEGORIES` ergänzen.

Setup — nutzt dasselbe Service Account wie `dagoberts-geldspeicher`
(`dagoberts-geldspeicher@dagoberts-geldspeicher.iam.gserviceaccount.com`), nur mit zusätzlichem
Drive-Zugriff:

1. **Drive API aktivieren** — [console.cloud.google.com](https://console.cloud.google.com), Projekt
   `dagoberts-geldspeicher` auswählen → **APIs & Dienste → Bibliothek** → "Google Drive API" suchen
   → **Aktivieren**
2. **Neuen JSON-Key erzeugen** — **APIs & Dienste → Anmeldedaten**, das Service Account
   `dagoberts-geldspeicher@...` anklicken → Tab **Keys → Add Key → Create new key → JSON**
   → Datei wird heruntergeladen
3. **Die `Health Sync ...`-Ordner freigeben** — in Google Drive jeden einzeln öffnen
   (Rechtsklick im Drive-Explorer) → **Freigeben** → E-Mail
   `dagoberts-geldspeicher@dagoberts-geldspeicher.iam.gserviceaccount.com` eintragen, Rolle
   **Betrachter**, **Senden** (Benachrichtigung kann deaktiviert werden, das Konto liest keine Mails)
4. **Schema einspielen:**
   ```powershell
   npm run db:migrate-sync
   npm run db:migrate-sync-bp
   npm run db:migrate-sync-v2
   npm run db:migrate-sync-v3
   ```
5. **Secret setzen** (kompletter Inhalt der heruntergeladenen JSON-Datei, eine Zeile):
   ```powershell
   npx wrangler pages secret put GOOGLE_SERVICE_ACCOUNT_JSON --project-name=oliver-health-tracker
   ```
   Browser-Weg: Pages-Projekt → **Settings → Environment variables → Add variable** — Name
   `GOOGLE_SERVICE_ACCOUNT_JSON`, Typ **Secret**, Wert = JSON-Inhalt
6. Neu deployen (`npm run deploy` oder Retry deployment im Dashboard), danach in der App unten bei
   **"Health Sync"** auf **"Jetzt synchronisieren"** klicken

Jede Datei wird nur einmal verarbeitet (Tracking in der Tabelle `sync_files`) — ein erneuter Klick
auf "Jetzt synchronisieren" holt nur neu hinzugekommene Dateien, nichts wird doppelt gezählt.
Pro Aufruf werden höchstens 30 Dateien geladen (Cloudflare-Limit für externe Anfragen);
liegen mehr vor, wiederholt der Button bzw. der Cron-Worker den Aufruf automatisch.

### Automatischer Sync
Aktuell: Die App synchronisiert beim Öffnen automatisch im Hintergrund (höchstens alle
3 Stunden pro Gerät).

Vorbereitet, aber noch ohne Zeitplan: `cron-worker/`. Der Free-Tarif erlaubt nur 5
Cron-Trigger pro Account, die alle durch andere Apps belegt sind. Wird ein Platz frei
(oder Workers Paid), nur noch den Zeitplan setzen:
`npx wrangler deploy --config cron-worker/wrangler.toml` (Worker und `SYNC_TOKEN` sind
schon eingerichtet).

Pages Functions haben keine Cron-Trigger, deshalb ruft der Worker
`oliver-health-tracker-sync` 2× täglich (06:17/18:17 Sommerzeit) `POST /api/sync` auf.
Er authentifiziert sich mit dem Secret `SYNC_TOKEN`, das im Worker **und** im
Pages-Projekt mit demselben (zufälligen) Wert gesetzt sein muss — der Token erlaubt
ausschließlich den Sync, keinen Zugriff auf Daten.

```powershell
npx wrangler deploy --config cron-worker/wrangler.toml
npx wrangler secret put SYNC_TOKEN --config cron-worker/wrangler.toml
npx wrangler pages secret put SYNC_TOKEN --project-name=oliver-health-tracker
```
