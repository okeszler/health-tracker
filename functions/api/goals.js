export async function onRequestGet({ env }) {
  const { results } = await env.DB.prepare("SELECT * FROM goals").all();
  const goals = {};
  for (const row of results) goals[row.key] = row.value;
  return Response.json(goals);
}

// nur bekannte Ziele mit plausiblen Werten (oder null = kein Ziel) annehmen
const GOAL_RANGES = { weight_kg: [20, 400], body_fat_pct: [2, 70] };
const GOAL_LABELS = { weight_kg: "Zielgewicht", body_fat_pct: "Ziel-Körperfett" };

export async function onRequestPost({ request, env }) {
  const body = await request.json().catch(() => ({}));
  const entries = Object.entries(body).filter(([key]) => key in GOAL_RANGES);
  for (const [key, value] of entries) {
    if (value === null) continue;
    const [min, max] = GOAL_RANGES[key];
    if (typeof value !== "number" || !isFinite(value) || value < min || value > max) {
      return Response.json({ error: `${GOAL_LABELS[key]} sollte zwischen ${min} und ${max} liegen` }, { status: 400 });
    }
  }
  if (!entries.length) return Response.json({ ok: true });
  const stmt = env.DB.prepare(
    "INSERT INTO goals (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  );
  await env.DB.batch(entries.map(([key, value]) => stmt.bind(key, value)));
  return Response.json({ ok: true });
}
