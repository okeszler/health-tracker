# Health Metrics Tracker

Cloudflare Pages + D1, gleiches Muster wie die anderen Cloudflare-Apps
(kratos-gymtracker, dagoberts-geldspeicher, ...).

## Struktur
- `public/index.html` — komplettes Frontend (Dashboard, Formulare, Charts, Logs)
- `public/manifest.json`, `public/favicon.ico`, `public/icons/` — App-Icons/Favicon
- `functions/_middleware.js` — Passwortschutz für die ganze App (siehe unten)
- `functions/api/metrics.js` — CRUD für tägliche Vitals (Gewicht, Körperzusammensetzung, Blutdruck, Puls)
- `functions/api/labs.js` — CRUD für Laborwerte (freier Testname + Einheit, rückwirkend erfassbar)
- `functions/api/goals.js` — Zielwerte (Gewicht, Körperfett)
- `schema.sql` — D1-Schema (für Neuaufsetzen)
- `migration_v2.sql` — nur nötig, falls du das ursprüngliche v1-Schema (mit Wasserzufuhr statt
  Blutwerten/Muskel%/Körperwasser%) schon deployed hattest
- `wrangler.toml`, `package.json` — Konfiguration

## Passwortschutz

Die App zeigt sensible Gesundheitsdaten, deshalb ist sie standardmäßig mit einem
gemeinsamen Passwort geschützt (einfacher Cookie-Login, kein Benutzerkonto nötig).
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
npx wrangler pages secret put APP_PASSWORD --project-name=health-tracker

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
