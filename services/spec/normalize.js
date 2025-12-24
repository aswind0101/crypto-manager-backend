// crypto-manager-backend/services/spec/normalize.js
export function sortKlines(klines = []) {
  return (klines || []).slice().sort((a, b) => Number(a.t) - Number(b.t));
}

export function dedupeKlines(sorted = []) {
  const out = [];
  let lastT = null;
  for (const k of sorted) {
    const t = Number(k.t);
    if (!Number.isFinite(t)) continue;
    if (lastT === t) continue;
    out.push({
      t,
      o: Number(k.o),
      h: Number(k.h),
      l: Number(k.l),
      c: Number(k.c),
      v: Number(k.v ?? 0),
    });
    lastT = t;
  }
  return out;
}

export function normalizeKlines(klines = []) {
  return dedupeKlines(sortKlines(klines));
}

// timeframe key -> ms
export function tfToMs(tfKey) {
  if (tfKey === "D") return 86400000;
  const n = Number(tfKey);
  if (!Number.isFinite(n)) throw new Error(`Invalid tfKey: ${tfKey}`);
  return n * 60_000;
}

/**
 * Determine last closed candle timestamp and whether the last item is closed.
 * Practical rule:
 * - if last candle is older than (tfMs) relative to now => it's closed
 * - else last closed is the previous candle
 */
export function computeLastClosed(klines, tfMs, nowTs = Date.now()) {
  if (!klines || klines.length < 2) {
    return { last_ts: null, last_closed_ts: null, is_last_closed: false };
  }
  const last = klines[klines.length - 1];
  const prev = klines[klines.length - 2];
  const lastTs = Number(last.t);

  const isLastClosed = Number.isFinite(lastTs) && (nowTs - lastTs) >= tfMs;
  const lastClosedTs = isLastClosed ? lastTs : Number(prev.t);

  return {
    last_ts: lastTs,
    last_closed_ts: lastClosedTs,
    is_last_closed: isLastClosed,
  };
}

export function gapReport(klines, tfMs) {
  if (!klines || klines.length < 3) return { has_gaps: false, gaps: [] };

  const gaps = [];
  for (let i = 1; i < klines.length; i++) {
    const dt = Number(klines[i].t) - Number(klines[i - 1].t);
    if (dt > tfMs * 1.5) {
      gaps.push({
        from: Number(klines[i - 1].t),
        to: Number(klines[i].t),
        missing_intervals_est: Math.round(dt / tfMs) - 1,
      });
    }
  }
  return { has_gaps: gaps.length > 0, gaps };
}

export function gradeDataQuality({ barsByTF, gapByTF, requiredBars = 220 }) {
  // Simple deterministic grading:
  // A: all TF bars>=requiredBars and no gaps
  // B: minor gaps or 1 TF short
  // C: multiple gaps or multiple TF short
  // D: critical short (any core TF < 60)
  const issues = [];

  const coreTFs = ["15", "60", "240", "D"];
  let shortCount = 0;
  let gapCount = 0;
  let critical = false;

  for (const tf of coreTFs) {
    const bars = Number(barsByTF[tf] ?? 0);
    if (bars < 60) critical = true;

    if (bars < requiredBars) {
      shortCount++;
      issues.push({ code: "INSUFFICIENT_BARS", tf, details: `need>=${requiredBars} got=${bars}` });
    }
    if (gapByTF[tf]?.has_gaps) {
      gapCount++;
      issues.push({ code: "GAP_DETECTED", tf, details: `gaps=${gapByTF[tf].gaps.length}` });
    }
  }

  let grade = "A";
  if (critical) grade = "D";
  else if (shortCount >= 2 || gapCount >= 2) grade = "C";
  else if (shortCount >= 1 || gapCount >= 1) grade = "B";

  return { grade, issues };
}
