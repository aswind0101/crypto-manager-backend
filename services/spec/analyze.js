// crypto-manager-backend/services/spec/analyze.js

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
  return (body / range) <= maxBodyToRange;
}

function chooseExecutionTF(snapshot) {
  // Spec-like: prioritize 60 then 15
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
  // Deterministic scoring to be explainable.
  const dq = snapshot.data_quality?.grade ?? "C";
  const adx = num(snapshot.indicators?.[tf]?.adx14);
  const rsi = num(snapshot.indicators?.[tf]?.rsi14);
  const regime = snapshot.price_structure?.[tf]?.regime;

  let score = 50;
  const breakdown = [];

  // data quality
  if (dq === "A") { score += 15; breakdown.push({ k: "data_quality", v: +15 }); }
  else if (dq === "B") { score += 5; breakdown.push({ k: "data_quality", v: +5 }); }
  else if (dq === "D") { score -= 15; breakdown.push({ k: "data_quality", v: -15 }); }
  else { breakdown.push({ k: "data_quality", v: 0 }); }

  // regime
  if (regime === "trend") { score += 10; breakdown.push({ k: "regime", v: +10 }); }
  if (regime === "range") { score += 5; breakdown.push({ k: "regime", v: +5 }); }

  // adx
  if (Number.isFinite(adx)) {
    if (adx >= 25) { score += 10; breakdown.push({ k: "adx", v: +10 }); }
    else if (adx < 18) { score -= 5; breakdown.push({ k: "adx", v: -5 }); }
    else breakdown.push({ k: "adx", v: 0 });
  } else breakdown.push({ k: "adx", v: -5 });

  // rsi sanity (avoid extremes)
  if (Number.isFinite(rsi)) {
    if (rsi > 80 || rsi < 20) { score -= 5; breakdown.push({ k: "rsi_extreme", v: -5 }); }
    else breakdown.push({ k: "rsi_extreme", v: 0 });
  }

  score = Math.max(0, Math.min(100, score));
  return { score, breakdown };
}

function entryPlanFromState(state) {
  if (state === "TRIGGERED") return { order_type: "market", note: "Đã có nến xác nhận (closed candle). Vào theo market." };
  if (state === "READY") return { order_type: "limit", note: "Setup READY. Đặt limit tại mid zone và chờ trigger." };
  if (state === "ALMOST_READY") return { order_type: "wait", note: "Gần đạt điều kiện. Chờ thêm xác nhận." };
  return { order_type: "wait", note: "Chưa đủ điều kiện. Chờ." };
}

function makeId(prefix, symbol, tf, name) {
  const s = `${prefix}|${symbol}|${tf}|${name}`;
  // deterministic hash (simple)
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h) + s.charCodeAt(i);
  return `${prefix}-${symbol}-${tf}-${Math.abs(h)}`;
}

/**
 * 3 setups, deterministic skeleton aligned with SPEC structure.
 * You can refine rules later; schema is stable now.
 */
export function analyzeSnapshotSpecV33(snapshot) {
  const symbol = snapshot.symbol;
  const tf = chooseExecutionTF(snapshot);
  const facts = buildCommonFacts(snapshot, tf);
  const g = snapshot.guards || {};
  const maxDoji = g?.doji?.max_body_to_range ?? 0.25;

  const candle = snapshot.indicators?.[tf]?.last_closed_candle ?? null;
  const proofClosed = Boolean(candle?.ts) && (candle.ts === snapshot.timeframes?.[tf]?.last_closed_ts);

  const setups = [];

  // --- Setup #1 Trend Pullback ---
  // Use: trend regime + pullback towards EMA20/VP VAL/VAH
  {
    const { score, breakdown } = scoreConfidence(snapshot, tf);
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

    // Determine direction by trend_label
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
      // Pullback zone heuristic: around EMA20 and VAL/VAH depending direction
      // This is deterministic and uses snapshot facts only.
      state = "READY";
      entry_validity = "ENTRY_OK";
    }

    // Zone & risk
    let zone = { low: null, high: null };
    let sl = null, tp1 = null, tp2 = null, tp3 = null, rr = null;

    if (entry_validity !== "ENTRY_OFF" && atr && close) {
      if (direction === "long") {
        const anchor = (ema20 != null ? ema20 : close);
        const lo = (val != null ? Math.min(val, anchor) : anchor) - 0.2 * atr;
        const hi = (val != null ? Math.max(val, anchor) : anchor) + 0.2 * atr;
        zone = { low: lo, high: hi };
        const entry = (lo + hi) / 2;
        sl = lo - 0.6 * atr;
        tp1 = entry + 1.0 * atr;
        tp2 = entry + 1.8 * atr;
        tp3 = entry + 2.6 * atr;
        rr = rrLong(entry, sl, tp2);
      } else if (direction === "short") {
        const anchor = (ema20 != null ? ema20 : close);
        const lo = (vah != null ? Math.min(vah, anchor) : anchor) - 0.2 * atr;
        const hi = (vah != null ? Math.max(vah, anchor) : anchor) + 0.2 * atr;
        zone = { low: lo, high: hi };
        const entry = (lo + hi) / 2;
        sl = hi + 0.6 * atr;
        tp1 = entry - 1.0 * atr;
        tp2 = entry - 1.8 * atr;
        tp3 = entry - 2.6 * atr;
        rr = rrShort(entry, sl, tp2);
      }
    }

    // RR hard guard
    if (entry_validity === "ENTRY_OK" && rr != null && rr < (g?.min_rr ?? 1.5)) {
      state = "INVALID";
      entry_validity = "ENTRY_OFF";
      missing.push(`RR<${g?.min_rr ?? 1.5}`);
    }

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
        plan: { ...entryPlanFromState(state), suggested_entry: (zone.low != null && zone.high != null) ? (zone.low + zone.high) / 2 : null }
      },
      risk: { sl, tp: [tp1, tp2, tp3], rr, atr_stop: null, atr_zone: null },
      confidence: { score, breakdown },
      why: {
        bullets: [
          `Regime=${facts.regime}, Trend=${facts.trend_label}`,
          `Closed-candle proof=${proofClosed}`,
        ],
        facts,
        missing_fields: missing,
      }
    });
  }

  // --- Setup #2 Breakout/Continuation ---
  {
    const { score, breakdown } = scoreConfidence(snapshot, tf);
    const missing = [];
    if (!proofClosed) missing.push(`timeframes.${tf}.last_closed_ts`);

    const atr = num(facts.atr14);
    const close = num(facts.close);
    const swingHigh = num(snapshot.price_structure?.[tf]?.swings?.last_swing_high);
    const swingLow = num(snapshot.price_structure?.[tf]?.swings?.last_swing_low);
    const accept = snapshot.guards?.acceptance?.min_close_beyond_atr ?? 0.1;

    let state = "BUILD_UP";
    let entry_validity = "ENTRY_WAIT";
    let direction = "none";
    let zone = { low: null, high: null };
    let sl = null, tp1 = null, tp2 = null, tp3 = null, rr = null;

    if (!proofClosed || atr == null || close == null) {
      state = "ALMOST_READY";
      entry_validity = "ENTRY_WAIT";
    } else if (swingHigh != null && (close > swingHigh + accept * atr)) {
      direction = "long";
      state = "TRIGGERED";
      entry_validity = "ENTRY_OK";
      zone = { low: swingHigh - 0.1 * atr, high: swingHigh + 0.3 * atr };
      const entry = close;
      sl = swingHigh - 0.8 * atr;
      tp1 = entry + 1.2 * atr;
      tp2 = entry + 2.0 * atr;
      tp3 = entry + 2.8 * atr;
      rr = rrLong(entry, sl, tp2);
    } else if (swingLow != null && (close < swingLow - accept * atr)) {
      direction = "short";
      state = "TRIGGERED";
      entry_validity = "ENTRY_OK";
      zone = { low: swingLow - 0.3 * atr, high: swingLow + 0.1 * atr };
      const entry = close;
      sl = swingLow + 0.8 * atr;
      tp1 = entry - 1.2 * atr;
      tp2 = entry - 2.0 * atr;
      tp3 = entry - 2.8 * atr;
      rr = rrShort(entry, sl, tp2);
    } else {
      state = "READY";
      entry_validity = "ENTRY_WAIT";
      direction = (facts.trend_label === "bull") ? "long" : (facts.trend_label === "bear") ? "short" : "both";
    }

    // RR guard
    if (entry_validity === "ENTRY_OK" && rr != null && rr < (snapshot.guards?.min_rr ?? 1.5)) {
      state = "INVALID";
      entry_validity = "ENTRY_OFF";
      missing.push(`RR<${snapshot.guards?.min_rr ?? 1.5}`);
    }

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
        plan: { ...entryPlanFromState(state), suggested_entry: close }
      },
      risk: { sl, tp: [tp1, tp2, tp3], rr, atr_stop: null, atr_zone: null },
      confidence: { score, breakdown },
      why: {
        bullets: [
          `SwingHigh=${swingHigh ?? "—"}, SwingLow=${swingLow ?? "—"}`,
          `Acceptance buffer=${accept}*ATR`,
        ],
        facts,
        missing_fields: missing,
      }
    });
  }

  // --- Setup #3 Range / Mean Reversion ---
  {
    const { score, breakdown } = scoreConfidence(snapshot, tf);
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
      // Mean-reversion: fade extremes of range box
      state = "READY";
      entry_validity = "ENTRY_OK";

      const loZ = box.lo + 0.15 * (box.hi - box.lo);
      const hiZ = box.hi - 0.15 * (box.hi - box.lo);

      // If near lower => long; near upper => short; else wait
      if (close <= loZ) {
        direction = "long";
        zone = { low: box.lo, high: loZ };
        const entry = (zone.low + zone.high) / 2;
        sl = box.lo - 0.8 * atr;
        tp1 = entry + 0.9 * atr;
        tp2 = entry + 1.5 * atr;
        tp3 = entry + 2.1 * atr;
        rr = rrLong(entry, sl, tp2);
      } else if (close >= hiZ) {
        direction = "short";
        zone = { low: hiZ, high: box.hi };
        const entry = (zone.low + zone.high) / 2;
        sl = box.hi + 0.8 * atr;
        tp1 = entry - 0.9 * atr;
        tp2 = entry - 1.5 * atr;
        tp3 = entry - 2.1 * atr;
        rr = rrShort(entry, sl, tp2);
      } else {
        state = "BUILD_UP";
        entry_validity = "ENTRY_WAIT";
        direction = "both";
      }
    }

    // RR guard
    if (entry_validity === "ENTRY_OK" && rr != null && rr < (snapshot.guards?.min_rr ?? 1.5)) {
      state = "INVALID";
      entry_validity = "ENTRY_OFF";
      missing.push(`RR<${snapshot.guards?.min_rr ?? 1.5}`);
    }

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
        plan: { ...entryPlanFromState(state), suggested_entry: (zone.low != null && zone.high != null) ? (zone.low + zone.high) / 2 : null }
      },
      risk: { sl, tp: [tp1, tp2, tp3], rr, atr_stop: null, atr_zone: null },
      confidence: { score, breakdown },
      why: {
        bullets: [
          `RangeBox: hi=${box?.hi ?? "—"}, lo=${box?.lo ?? "—"}, width_atr=${box?.width_atr ?? "—"}`,
          `BB20/2: mid=${bb?.mid ?? "—"} upper=${bb?.upper ?? "—"} lower=${bb?.lower ?? "—"}`,
        ],
        facts,
        missing_fields: missing,
      }
    });
  }

  // Action summary: pick best actionable
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
