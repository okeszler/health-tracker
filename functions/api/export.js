// GET /api/export?type=metrics -> manuelle Vitals-Einträge als CSV
// GET /api/export?type=labs    -> Blutwerte als CSV
//
// Format für Excel/Numbers im deutschsprachigen Raum: Semikolon als Trenner,
// Dezimalkomma, UTF-8 mit BOM (sonst zeigt Excel Umlaute falsch an).

const EXPORTS = {
  metrics: {
    sql: "SELECT * FROM metrics ORDER BY entry_date",
    filename: "vitals",
    columns: [
      ["entry_date", "Datum"],
      ["weight_kg", "Gewicht (kg)"],
      ["body_fat_pct", "Körperfett (%)"],
      ["muscle_pct", "Muskel (%)"],
      ["body_water_pct", "Körperwasser (%)"],
      ["bp_systolic", "RR systolisch"],
      ["bp_diastolic", "RR diastolisch"],
      ["pulse", "Puls"],
      ["note", "Notiz"],
    ],
  },
  labs: {
    sql: "SELECT * FROM lab_results ORDER BY entry_date, test_name",
    filename: "blutwerte",
    columns: [
      ["entry_date", "Datum"],
      ["test_name", "Test"],
      ["value", "Wert"],
      ["unit", "Einheit"],
      ["note", "Notiz"],
    ],
  },
};

function cell(v) {
  if (v === null || v === undefined) return "";
  const s = typeof v === "number" ? String(v).replace(".", ",") : String(v);
  return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export async function onRequestGet({ request, env }) {
  const type = new URL(request.url).searchParams.get("type");
  const spec = EXPORTS[type];
  if (!spec) return Response.json({ error: "type muss metrics oder labs sein" }, { status: 400 });

  const { results } = await env.DB.prepare(spec.sql).all();
  const lines = [
    spec.columns.map(([, label]) => cell(label)).join(";"),
    ...results.map((row) => spec.columns.map(([key]) => cell(row[key])).join(";")),
  ];
  const today = new Date().toISOString().slice(0, 10);
  return new Response("﻿" + lines.join("\r\n") + "\r\n", {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${spec.filename}-${today}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
