// Automatischer Health-Sync: Cloudflare Pages Functions haben keine Cron-
// Trigger, deshalb ruft dieser kleine Worker 2x täglich POST /api/sync der App
// auf -- authentifiziert per SYNC_TOKEN (gleicher Secret-Wert im Pages-Projekt,
// siehe functions/_middleware.js).
//
// Der Sync lädt pro Aufruf nur eine begrenzte Zahl Dateien (Cloudflare-Limit)
// und meldet den Rest als "remaining" -- deshalb wird wiederholt, bis nichts
// mehr übrig ist.

async function runSync(env) {
  for (let round = 1; round <= 15; round++) {
    const res = await fetch(env.SYNC_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.SYNC_TOKEN}` },
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error(`Sync fehlgeschlagen (HTTP ${res.status})`, body.error || "");
      return;
    }
    console.log(`Sync-Runde ${round}`, JSON.stringify(body.summary));
    if (!body.remaining) return;
  }
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runSync(env));
  },
};
