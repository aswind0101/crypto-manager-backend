// crypto-manager-backend/services/spec/render.js

function fmt(n) {
  if (n == null || Number.isNaN(Number(n))) return "—";
  const x = Number(n);
  if (!Number.isFinite(x)) return "—";
  return x.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

export function buildUiBlocks({ snapshot, analysisResult }) {
  const { dashboard, setups, actionSummary, selfCheck } = analysisResult;

  const blocks = [];

  blocks.push({
    type: "header",
    title: "MODE A — DASH/CHECK/PART/SETUPS",
    subtitle: `Symbol=${dashboard.symbol} | AsOf=${new Date(dashboard.asof_ts).toLocaleString()}`,
  });

  blocks.push({
    type: "dataQuality",
    payload: dashboard.data_quality,
  });

  blocks.push({
    type: "dashboard",
    payload: {
      symbol: dashboard.symbol,
      execution_tf: dashboard.execution_tf,
      price: dashboard.market?.price,
      ticker_24h: dashboard.market?.ticker_24h,
      derivatives: dashboard.market?.derivatives,
      structure: dashboard.structure,
    }
  });

  blocks.push({
    type: "setups",
    payload: setups,
  });

  blocks.push({
    type: "actionSummary",
    payload: actionSummary,
  });

  blocks.push({
    type: "selfCheck",
    payload: selfCheck,
  });

  return blocks;
}

export function renderMarkdownVi({ snapshot, analysisResult }) {
  const { dashboard, setups, actionSummary, selfCheck } = analysisResult;

  const lines = [];
  lines.push(`MODE A — DASH/CHECK/PART/SETUPS`);
  lines.push(``);
  lines.push(`PHẦN 0) METADATA`);
  lines.push(`- Symbol: ${dashboard.symbol}`);
  lines.push(`- AsOf: ${new Date(dashboard.asof_ts).toLocaleString()}`);
  lines.push(`- Snapshot: ${snapshot.snapshot_version}`);
  lines.push(``);

  lines.push(`PHẦN I) DATA QUALITY`);
  lines.push(`- Grade: ${dashboard.data_quality?.grade ?? "—"}`);
  const issues = dashboard.data_quality?.issues ?? [];
  if (issues.length) {
    for (const it of issues) lines.push(`  - ${it.code} (${it.tf}): ${it.details}`);
  } else {
    lines.push(`- Issues: none`);
  }
  lines.push(``);

  lines.push(`PHẦN IV) SETUPS (3)`);
  for (const s of setups) {
    lines.push(``);
    lines.push(`### ${s.name} [TF ${s.timeframe}]`);
    lines.push(`- STATE: ${s.state}`);
    lines.push(`- ENTRY_VALIDITY: ${s.entry_validity}`);
    lines.push(`- DIRECTION: ${s.direction}`);
    lines.push(`- ZONE: ${fmt(s.entry?.zone?.low)} → ${fmt(s.entry?.zone?.high)}`);
    lines.push(`- SL: ${fmt(s.risk?.sl)} | TP: ${s.risk?.tp?.map(fmt).join(" / ")}`);
    lines.push(`- RR (vs TP2): ${fmt(s.risk?.rr)}`);
    lines.push(`- CONFIDENCE: ${s.confidence?.score}`);
    lines.push(`- TRIGGER: ${s.entry?.trigger?.type} | closed_proof=${String(s.entry?.trigger?.proof_closed)}`);
    lines.push(`- WHY:`);
    for (const b of (s.why?.bullets ?? [])) lines.push(`  - ${b}`);
    const mf = s.why?.missing_fields ?? [];
    if (mf.length) lines.push(`  - Missing/Guards: ${mf.join(", ")}`);
  }

  lines.push(``);
  lines.push(`PHẦN V) ACTION SUMMARY`);
  if (actionSummary.best) {
    lines.push(`- Best: ${actionSummary.best.name} | ${actionSummary.best.entry_validity} | score=${actionSummary.best.confidence.score}`);
  } else {
    lines.push(`- Best: none`);
  }

  lines.push(``);
  lines.push(`🧾 SELF-CHECK:`);
  lines.push(`- closed_candle_proof: ${String(selfCheck.closed_candle_proof)}`);
  lines.push(`- has_three_setups: ${String(selfCheck.has_three_setups)}`);
  lines.push(`- snapshot_version_ok: ${String(selfCheck.snapshot_version_ok)}`);

  return lines.join("\n");
}
