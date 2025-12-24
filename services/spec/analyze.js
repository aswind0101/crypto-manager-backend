// crypto-manager-backend/services/spec/analyze.js
// MODE: Transparent (always try to provide Zone/SL/TP preview even when ENTRY_OFF)

function num(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

function rrLong(entry, sl, tp) {
  if ([entry, sl, tp].some((x) => x == null)) return null;
  const risk = entry - sl;
  const reward = tp - entry;
  if (risk <= 0) return null;
  return reward / risk;
}

function rrShort(entry, sl, tp) {
  if ([entry, sl, tp].some((x) => x == null)) return null;
  const risk = sl - entry;
  const reward = entry - tp;
  if (risk <= 0) return null;
  return reward / risk;
}

function isDoji(candle, maxBodyToRange) {
  if (!candle) return false;
  const body = Math.abs(candle.c - candle.o);
  const range = candle.h - candle.l;
  if (range <= 0) return false;
  return body / range <= maxBodyToRange;
}

function chooseExecutionTF(snapshot) {
  // Prefer H1 then M15
  const tf60 = snapshot?.timeframes?.["60"]?.bars ?? 0;
  const tf15 = snapshot?.timeframes?.["15"]?.bars ?? 0;
  if (tf60 >= 120) return "60";
  if (tf15 >= 120) return "15";
  return "60";
}

function buildCommonFacts(snapshot, tf) {
  const ind = snapshot.indicators?.[tf] || {};
  const vp = snapshot.volume_profile?.[tf] || {};
  return {
    tf,
    close: ind.last_closed_candle?.c ?? null,
    atr14: ind.atr14?.value ?? null,
    ema20: ind.ema?.["20"] ?? null,
    ema50: ind.ema?.["50"] ?? null,
    ema200: ind.ema?.["200"] ?? null,
    rsi14: ind.rsi14 ?? null,
    adx14: ind.adx14 ?? null,
    poc: vp.poc ?? null,
    vah: vp.vah ?? null,
    val: vp.val ?? null,
    regime: snapshot.price_structure?.[tf]?.regime ?? null,
    trend_label: snapshot.price_structure?.[tf]?.trend_label ?? null,
  };
}

function scoreConfidence(snapshot, tf) {
  // Deterministic base scoring (facts-only)
  const dq = snapshot.data_quality?.grade ?? "C";
  const adx = num(snapshot.indicators?.[tf]?.adx14);
  const rsi = num(snapshot.indicators?.[tf]?.rsi14);
  const regime = snapshot.price_structure?.[tf]?.regime;

  let score = 50;
  const breakdown = [];

  if (dq === "A") { score += 15; breakdown.push({ k: "data_quality", v: +15 }); }
  else if (dq === "B") { score += 5; breakdown.push({ k: "data_quality", v: +5 }); }
  else if (dq === "D") { score -= 15; breakdown.push({ k: "data_quality", v: -15 }); }
  else { breakdown.push({ k: "data_quality", v: 0 }); }

  if (regime === "trend") { score += 10; breakdown.push({ k: "regime", v: +10 }); }
  else if (regime === "range") { score += 5; breakdown.push({ k: "regime", v: +5 }); }
  else breakdown.push({ k: "regime", v: 0 });

  if (Number.isFinite(adx)) {
    if (adx >= 25) { score += 10; breakdown.push({ k: "adx", v: +10 }); }
    else if (adx < 18) { score -= 5; breakdown.push({ k: "adx", v: -5 }); }
    else breakdown.push({ k: "adx", v: 0 });
  } else {
    score -= 5;
    breakdown.push({ k: "adx", v: -5 });
  }

  if (Number.isFinite(rsi)) {
    if (rsi > 80 || rsi < 20) { score -= 5; breakdown.push({ k: "rsi_extreme", v: -5 }); }
    else breakdown.push({ k: "rsi_extreme", v: 0 });
  } else {
    breakdown.push({ k: "rsi_extreme", v: 0 });
  }

  score = Math.max(0, Math.min(100, score));
  return { score, breakdown };
}

function adjustConfidenceByState(baseScore, state, entry_validity) {
  let s = Number(baseScore);
  if (!Number.isFinite(s)) s = 50;

  if (entry_validity === "ENTRY_OFF") s -= 25;
  if (entry_validity === "ENTRY_WAIT") s -= 8;
  if (entry_validity === "ENTRY_OK") s += 6;

  if (state === "INVALID") s -= 25;
  if (state === "BUILD_UP") s -= 10;
  if (state === "ALMOST_READY") s -= 5;
  if (state === "READY") s += 5;
  if (state === "TRIGGERED") s += 10;
  if (state === "MOMENTUM_TRAP") s -= 12;

  return Math.max(0, Math.min(100, s));
}

function entryPlanFromState(state) {
  if (state === "TRIGGERED") return { order_type: "market", note: "Đã có nến xác nhận (closed candle). Vào theo market." };
  if (state === "READY") return { order_type: "limit", note: "Setup READY. Đặt limit tại mid zone và chờ trigger." };
  if (state === "ALMOST_READY") return { order_type: "wait", note: "Gần đạt điều kiện. Chờ thêm xác nhận." };
  return { order_type: "wait", note: "Chưa đủ điều kiện. Chờ." };
}

function makeId(prefix, symbol, tf, name) {
  const s = `${prefix}|${symbol}|${tf}|${name}`;
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h) + s.charCodeAt(i);
  return `${prefix}-${symbol}-${tf}-${Math.abs(h)}`;
}

// ---------- Transparent Plan Builders (always try) ----------

function mid(low, high) {
  if (low == null || high == null) return null;
  return (low + high) / 2;
}

function buildTrendPullbackPlan({ direction, atr, close, ema20, val, vah }) {
  if (atr == null || close == null) return null;
  if (direction !== "long" && direction !== "short") return null;

  if (direction === "long") {
    const anchor = (ema20 != null ? ema20 : close);
    const lo = (val != null ? Math.min(val, anchor) : anchor) - 0.2 * atr;
    const hi = (val != null ? Math.max(val, anchor) : anchor) + 0.2 * atr;
    const entry = (lo + hi) / 2;
    const sl = lo - 0.6 * atr;
    const tp1 = entry + 1.0 * atr;
    const tp2 = entry + 1.8 * atr;
    const tp3 = entry + 2.6 * atr;
    return { zone: { low: lo, high: hi }, sl, tp: [tp1, tp2, tp3], rr: rrLong(entry, sl, tp2) };
  }

  // short
  const anchor = (ema20 != null ? ema20 : close);
  const lo = (vah != null ? Math.min(vah, anchor) : anchor) - 0.2 * atr;
  const hi = (vah != null ? Math.max(vah, anchor) : anchor) + 0.2 * atr;
  const entry = (lo + hi) / 2;
  const sl = hi + 0.6 * atr;
  const tp1 = entry - 1.0 * atr;
  const tp2 = entry - 1.8 * atr;
  const tp3 = entry - 2.6 * atr;
  return { zone: { low: lo, high: hi }, sl, tp: [tp1, tp2, tp3], rr: rrShort(entry, sl, tp2) };
}

function buildBreakoutPlan({ direction, atr, close, swingHigh, swingLow, rangeBox }) {
  if (atr == null) return null;

  const useHigh = (swingHigh != null) ? swingHigh : (rangeBox?.hi ?? null);
  const useLow  = (swingLow  != null) ? swingLow  : (rangeBox?.lo ?? null);

  if (useHigh == null && useLow == null) return null;

  // If direction is both/none, choose nearer side to price (deterministic)
  const distToHigh = (useHigh != null && close != null) ? Math.abs(close - useHigh) : Infinity;
  const distToLow  = (useLow  != null && close != null) ? Math.abs(close - useLow)  : Infinity;

  let chosen = direction;
  if (direction === "both" || direction === "none" || direction == null) {
    chosen = (distToLow <= distToHigh) ? "short" : "long";
  } else if (direction === "long" && useHigh == null) {
    chosen = (useLow != null) ? "short" : "long";
  } else if (direction === "short" && useLow == null) {
    chosen = (useHigh != null) ? "long" : "short";
  }

  if (chosen === "long") {
    if (useHigh == null) return null;
    const lo = useHigh - 0.15 * atr;
    const hi = useHigh + 0.35 * atr;
    const entry = (lo + hi) / 2;
    const sl = useHigh - 0.9 * atr;
    const tp1 = entry + 1.2 * atr;
    const tp2 = entry + 2.0 * atr;
    const tp3 = entry + 2.8 * atr;
    return { zone: { low: lo, high: hi }, sl, tp: [tp1, tp2, tp3], rr: rrLong(entry, sl, tp2) };
  }

  // short
  if (useLow == null) return null;
  const lo = useLow - 0.35 * atr;
  const hi = useLow + 0.15 * atr;
  const entry = (lo + hi) / 2;
  const sl = useLow + 0.9 * atr;
  const tp1 = entry - 1.2 * atr;
  const tp2 = entry - 2.0 * atr;
  const tp3 = entry - 2.8 * atr;
  return { zone: { low: lo, high: hi }, sl, tp: [tp1, tp2, tp3], rr: rrShort(entry, sl, tp2) };
}

function buildRangeMRPlan({ atr, close, rangeBox }) {
  if (atr == null || close == null) return null;
  if (!rangeBox?.hi || !rangeBox?.lo) return null;

  const hi = rangeBox.hi;
  const lo = rangeBox.lo;
  const loZ = lo + 0.15 * (hi - lo);
  const hiZ = hi - 0.15 * (hi - lo);

  // Choose nearer extreme as preview plan
  const distLow = Math.abs(close - loZ);
  const distHigh = Math.abs(close - hiZ);

  if (distLow <= distHigh) {
    const zone = { low: lo, high: loZ };
    const entry = (zone.low + zone.high) / 2;
    const sl = lo - 0.8 * atr;
    const tp1 = entry + 0.9 * atr;
    const tp2 = entry + 1.5 * atr;
    const tp3 = entry + 2.1 * atr;
    return { direction: "long", zone, sl, tp: [tp1, tp2, tp3], rr: rrLong(entry, sl, tp2) };
  } else {
    const zone = { low: hiZ, high: hi };
    const entry = (zone.low + zone.high) / 2;
    const sl = hi + 0.8 * atr;
    const tp1 = entry - 0.9 * atr;
    const tp2 = entry - 1.5 * atr;
    const tp3 = entry - 2.1 * atr;
    return { direction: "short", zone, sl, tp: [tp1, tp2, tp3], rr: rrShort(entry, sl, tp2) };
  }
}

export function analyzeSnapshotSpecV33(snapshot) {
  const symbol = snapshot.symbol;
  const tf = chooseExecutionTF(snapshot);
  const facts = buildCommonFacts(snapshot, tf);

  const g = snapshot.guards || {};
  const minRR = g?.min_rr ?? 1.5;
  const maxDoji = g?.doji?.max_body_to_range ?? 0.25;

  const candle = snapshot.indicators?.[tf]?.last_closed_candle ?? null;
  const proofClosed = Boolean(candle?.ts) && (candle.ts === snapshot.timeframes?.[tf]?.last_closed_ts);

  const setups = [];

  // -------------------------
  // Setup #1 — Trend Pullback
  // -------------------------
  {
    const base = scoreConfidence(snapshot, tf);
    const missing = [];
    if (!proofClosed) missing.push(`timeframes.${tf}.last_closed_ts`);

    const atr = num(facts.atr14);
    const close = num(facts.close);
    const ema20 = num(facts.ema20);
    const val = num(facts.val);
    const vah = num(facts.vah);

    let state = "BUILD_UP";
    let entry_validity = "ENTRY_WAIT";
    let direction = "none";

    if (facts.trend_label === "bull") direction = "long";
    if (facts.trend_label === "bear") direction = "short";

    const isTrend = snapshot.price_structure?.[tf]?.regime === "trend";
    const isDojiNow = isDoji(candle, maxDoji);

    if (!isTrend || direction === "none") {
      state = "INVALID";
      entry_validity = "ENTRY_OFF";
    } else if (!proofClosed) {
      state = "ALMOST_READY";
      entry_validity = "ENTRY_WAIT";
    } else if (isDojiNow) {
      state = "MOMENTUM_TRAP";
      entry_validity = "ENTRY_WAIT";
    } else {
      state = "READY";
      entry_validity = "ENTRY_OK";
    }

    // Transparent plan: always try to build
    let zone = { low: null, high: null };
    let sl = null, tp1 = null, tp2 = null, tp3 = null, rr = null;

    const plan = buildTrendPullbackPlan({ direction, atr, close, ema20, val, vah });
    if (plan) {
      zone = plan.zone;
      sl = plan.sl;
      tp1 = plan.tp[0];
      tp2 = plan.tp[1];
      tp3 = plan.tp[2];
      rr = plan.rr;
    } else {
      if (atr == null) missing.push(`indicators.${tf}.atr14.value`);
      if (close == null) missing.push(`indicators.${tf}.last_closed_candle.c`);
      if (direction === "none") missing.push(`price_structure.${tf}.trend_label`);
    }

    // RR hard guard only blocks ENTRY_OK, but plan can still be shown
    if (entry_validity === "ENTRY_OK" && rr != null && rr < minRR) {
      state = "INVALID";
      entry_validity = "ENTRY_OFF";
      missing.push(`RR<${minRR}`);
    }

    const finalScore = adjustConfidenceByState(base.score, state, entry_validity);
    const breakdown = base.breakdown.concat([{ k: "state_validity_adjust", v: finalScore - base.score }]);

    setups.push({
      id: makeId("S1", symbol, tf, "trend_pullback"),
      name: "Setup #1 — Trend Pullback",
      timeframe: tf,
      state,
      entry_validity,
      direction,
      entry: {
        zone,
        trigger: { type: "close_confirm", ts: candle?.ts ?? null, proof_closed: proofClosed },
        plan: {
          ...entryPlanFromState(state),
          suggested_entry: mid(zone.low, zone.high),
          note:
            entry_validity === "ENTRY_OFF"
              ? "Preview plan (ENTRY_OFF). Không trade. Dùng để tham khảo/audit."
              : entryPlanFromState(state).note
        }
      },
      risk: { sl, tp: [tp1, tp2, tp3], rr, atr_stop: null, atr_zone: null },
      confidence: { score: finalScore, breakdown },
      why: {
        bullets: [
          `Regime=${facts.regime}, Trend=${facts.trend_label}`,
          `Closed-candle proof=${proofClosed}`,
          `Mode=Transparent (always show plan if possible)`,
        ],
        facts,
        missing_fields: missing,
      }
    });
  }

  // --------------------------------
  // Setup #2 — Breakout/Continuation
  // --------------------------------
  {
    const base = scoreConfidence(snapshot, tf);
    const missing = [];
    if (!proofClosed) missing.push(`timeframes.${tf}.last_closed_ts`);

    const atr = num(facts.atr14);
    const close = num(facts.close);
    const swingHigh = num(snapshot.price_structure?.[tf]?.swings?.last_swing_high);
    const swingLow = num(snapshot.price_structure?.[tf]?.swings?.last_swing_low);
    const rangeBox = snapshot.price_structure?.[tf]?.range_box ?? null;
    const accept = snapshot.guards?.acceptance?.min_close_beyond_atr ?? 0.1;

    let state = "BUILD_UP";
    let entry_validity = "ENTRY_WAIT";
    let direction = "none";
    let zone = { low: null, high: null };
    let sl = null, tp1 = null, tp2 = null, tp3 = null, rr = null;

    // Determine directional bias from trend_label, but breakout can be both
    direction = (facts.trend_label === "bull") ? "long" : (facts.trend_label === "bear") ? "short" : "both";

    if (!proofClosed || atr == null || close == null) {
      state = "ALMOST_READY";
      entry_validity = "ENTRY_WAIT";
    } else if (swingHigh != null && (close > swingHigh + accept * atr)) {
      // triggered long
      direction = "long";
      state = "TRIGGERED";
      entry_validity = "ENTRY_OK";
      const plan = buildBreakoutPlan({ direction, atr, close, swingHigh, swingLow, rangeBox });
      if (plan) {
        zone = plan.zone; sl = plan.sl; tp1 = plan.tp[0]; tp2 = plan.tp[1]; tp3 = plan.tp[2]; rr = plan.rr;
      }
    } else if (swingLow != null && (close < swingLow - accept * atr)) {
      // triggered short
      direction = "short";
      state = "TRIGGERED";
      entry_validity = "ENTRY_OK";
      const plan = buildBreakoutPlan({ direction, atr, close, swingHigh, swingLow, rangeBox });
      if (plan) {
        zone = plan.zone; sl = plan.sl; tp1 = plan.tp[0]; tp2 = plan.tp[1]; tp3 = plan.tp[2]; rr = plan.rr;
      }
    } else {
      // READY but not triggered: still provide plan (breakout band)
      state = "READY";
      entry_validity = "ENTRY_WAIT";
    }

    // Transparent plan: if we still don't have zone, build preview plan
    if (zone.low == null || zone.high == null) {
      const plan = buildBreakoutPlan({ direction, atr, close, swingHigh, swingLow, rangeBox });
      if (plan) {
        zone = plan.zone; sl = plan.sl; tp1 = plan.tp[0]; tp2 = plan.tp[1]; tp3 = plan.tp[2]; rr = plan.rr;
      } else {
        if (atr == null) missing.push(`indicators.${tf}.atr14.value`);
        if ((swingHigh == null && swingLow == null) && (!rangeBox?.hi || !rangeBox?.lo)) {
          missing.push(`price_structure.${tf}.swings.last_swing_high/low OR price_structure.${tf}.range_box`);
        }
      }
    }

    // RR guard only blocks ENTRY_OK
    if (entry_validity === "ENTRY_OK" && rr != null && rr < minRR) {
      state = "INVALID";
      entry_validity = "ENTRY_OFF";
      missing.push(`RR<${minRR}`);
    }

    const finalScore = adjustConfidenceByState(base.score, state, entry_validity);
    const breakdown = base.breakdown.concat([{ k: "state_validity_adjust", v: finalScore - base.score }]);

    setups.push({
      id: makeId("S2", symbol, tf, "breakout_continuation"),
      name: "Setup #2 — Breakout / Continuation",
      timeframe: tf,
      state,
      entry_validity,
      direction,
      entry: {
        zone,
        trigger: { type: "acceptance", ts: candle?.ts ?? null, proof_closed: proofClosed },
        plan: {
          ...entryPlanFromState(state),
          suggested_entry: (state === "TRIGGERED" ? close : mid(zone.low, zone.high)),
          note:
            entry_validity === "ENTRY_OFF"
              ? "Preview plan (ENTRY_OFF). Không trade. Dùng để tham khảo/audit."
              : entryPlanFromState(state).note
        }
      },
      risk: { sl, tp: [tp1, tp2, tp3], rr, atr_stop: null, atr_zone: null },
      confidence: { score: finalScore, breakdown },
      why: {
        bullets: [
          `SwingHigh=${swingHigh ?? "—"}, SwingLow=${swingLow ?? "—"}`,
          `Fallback range_box: hi=${rangeBox?.hi ?? "—"}, lo=${rangeBox?.lo ?? "—"}`,
          `Acceptance buffer=${accept}*ATR`,
          `Mode=Transparent (always show plan if possible)`,
        ],
        facts,
        missing_fields: missing,
      }
    });
  }

  // -----------------------------------------
  // Setup #3 — Range / Mean Reversion
  // -----------------------------------------
  {
    const base = scoreConfidence(snapshot, tf);
    const missing = [];
    if (!proofClosed) missing.push(`timeframes.${tf}.last_closed_ts`);

    const atr = num(facts.atr14);
    const close = num(facts.close);
    const box = snapshot.price_structure?.[tf]?.range_box ?? null;
    const bb = snapshot.indicators?.[tf]?.bb20_2 ?? {};

    let state = "BUILD_UP";
    let entry_validity = "ENTRY_WAIT";
    let direction = "both";

    let zone = { low: null, high: null };
    let sl = null, tp1 = null, tp2 = null, tp3 = null, rr = null;

    const isRange = snapshot.price_structure?.[tf]?.regime === "range";

    if (!isRange) {
      state = "INVALID";
      entry_validity = "ENTRY_OFF";
    } else if (!proofClosed || atr == null || close == null || !box?.hi || !box?.lo) {
      state = "ALMOST_READY";
      entry_validity = "ENTRY_WAIT";
    } else {
      // If in range and has box => READY; entry depends on proximity in a stricter version,
      // but transparent mode still shows a plan.
      state = "READY";
      entry_validity = "ENTRY_OK";
    }

    // Transparent plan: always try to build from range_box
    const plan = buildRangeMRPlan({ atr, close, rangeBox: box });
    if (plan) {
      direction = plan.direction; // override to preview near side
      zone = plan.zone;
      sl = plan.sl;
      tp1 = plan.tp[0];
      tp2 = plan.tp[1];
      tp3 = plan.tp[2];
      rr = plan.rr;
    } else {
      if (atr == null) missing.push(`indicators.${tf}.atr14.value`);
      if (close == null) missing.push(`indicators.${tf}.last_closed_candle.c`);
      if (!box?.hi || !box?.lo) missing.push(`price_structure.${tf}.range_box`);
    }

    // RR guard only blocks ENTRY_OK
    if (entry_validity === "ENTRY_OK" && rr != null && rr < minRR) {
      state = "INVALID";
      entry_validity = "ENTRY_OFF";
      missing.push(`RR<${minRR}`);
    }

    const finalScore = adjustConfidenceByState(base.score, state, entry_validity);
    const breakdown = base.breakdown.concat([{ k: "state_validity_adjust", v: finalScore - base.score }]);

    setups.push({
      id: makeId("S3", symbol, tf, "range_mean_reversion"),
      name: "Setup #3 — Range / Liquidity / Mean Reversion",
      timeframe: tf,
      state,
      entry_validity,
      direction,
      entry: {
        zone,
        trigger: { type: "rejection", ts: candle?.ts ?? null, proof_closed: proofClosed },
        plan: {
          ...entryPlanFromState(state),
          suggested_entry: mid(zone.low, zone.high),
          note:
            entry_validity === "ENTRY_OFF"
              ? "Preview plan (ENTRY_OFF). Không trade. Dùng để tham khảo/audit."
              : entryPlanFromState(state).note
        }
      },
      risk: { sl, tp: [tp1, tp2, tp3], rr, atr_stop: null, atr_zone: null },
      confidence: { score: finalScore, breakdown },
      why: {
        bullets: [
          `Regime=${snapshot.price_structure?.[tf]?.regime ?? "—"}`,
          `RangeBox: hi=${box?.hi ?? "—"}, lo=${box?.lo ?? "—"}, width_atr=${box?.width_atr ?? "—"}`,
          `BB20/2: mid=${bb?.mid ?? "—"} upper=${bb?.upper ?? "—"} lower=${bb?.lower ?? "—"}`,
          `Mode=Transparent (always show plan if possible)`,
        ],
        facts,
        missing_fields: missing,
      }
    });
  }

  // Action summary: pick best by confidence among actionable + wait
  const actionable = setups
    .filter((s) => s.entry_validity === "ENTRY_OK" || s.entry_validity === "ENTRY_WAIT")
    .sort((a, b) => (b.confidence.score - a.confidence.score));

  const actionSummary = {
    best: actionable[0] || null,
    reason: actionable[0] ? "highest_confidence" : "no_setups_actionable",
  };

  const selfCheck = {
    closed_candle_proof: setups.every((s) => s.entry?.trigger?.proof_closed !== false),
    has_three_setups: setups.length === 3,
    snapshot_version_ok: snapshot.snapshot_version === "3.3-internal-full",
  };

  const dashboard = {
    symbol,
    asof_ts: snapshot.asof_ts,
    data_quality: snapshot.data_quality,
    market: snapshot.market,
    execution_tf: tf,
    htf: "240",
    d1: "D",
    structure: {
      "15": snapshot.price_structure?.["15"],
      "60": snapshot.price_structure?.["60"],
      "240": snapshot.price_structure?.["240"],
      "D": snapshot.price_structure?.["D"],
    }
  };

  return { dashboard, setups, actionSummary, selfCheck };
}
