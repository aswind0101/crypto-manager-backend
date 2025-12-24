// crypto-manager-backend/services/tradeZoneEngineClientMultiTF_v2.js
import { normalizeKlines, tfToMs, computeLastClosed, gapReport, gradeDataQuality } from "./spec/normalize.js";
import { buildSnapshotInternalFull } from "./spec/snapshot.js";
import { analyzeSnapshotSpecV33 } from "./spec/analyze.js";
import { buildUiBlocks, renderMarkdownVi } from "./spec/render.js";

/**
 * New contract (client->backend):
 * body: {
 *   symbol,
 *   receivedAt?,
 *   raw?: { market?:..., fetched_at_ts, server_time_ts, request_ids:[] },
 *   klinesByTF: { "5":[], "15":[], "60":[], "240":[], "D":[] }
 * }
 */
export function runSpecPipelineFromClientRaw_v1({ symbol, receivedAt, raw, klinesByTF }) {
  const nowTs = Number(receivedAt || Date.now());
  const s = (symbol || "ETHUSDT").toString().trim().toUpperCase();

  // Normalize klines (keep keys as "5","15","60","240","D")
  const wanted = ["5", "15", "60", "240", "D"];
  const cleanKlinesByTF = {};
  for (const tf of wanted) {
    cleanKlinesByTF[tf] = normalizeKlines(klinesByTF?.[tf] || []);
  }

  // Build snapshot (Compute happens inside snapshot builder)
  const snapshot = buildSnapshotInternalFull({
    symbol: s,
    nowTs,
    raw: raw || {},
    klinesByTF: cleanKlinesByTF,
  });

  // Analyze snapshot (SPEC-like 3 setups)
  const analysisResult = analyzeSnapshotSpecV33(snapshot);

  // Render UI blocks + optional markdown
  const uiBlocks = buildUiBlocks({ snapshot, analysisResult });
  const rendered_markdown_vi = renderMarkdownVi({ snapshot, analysisResult });

  // Keep backward-compat fields for your old frontend (tradeZones/report)
  // tradeZones here can be derived later; for now return setups as primary.
  return {
    meta: {
      symbol: s,
      generatedAt: nowTs,
      snapshotVersion: snapshot.snapshot_version,
    },
    snapshot,                 // full evidence artifact
    dashboard: analysisResult.dashboard,
    setups: analysisResult.setups,
    actionSummary: analysisResult.actionSummary,
    selfCheck: analysisResult.selfCheck,
    uiBlocks,
    rendered_markdown_vi,
    // legacy fields (optional)
    tradeZones: [],
    report: {
      timeframes: snapshot.timeframes,
      data_quality: snapshot.data_quality,
      price_structure: snapshot.price_structure,
    },
  };
}
