// crypto-manager-backend/services/tradeZoneEngineClientMultiTF.js
import crypto from "crypto";

/**
 * Multi-TF Trade Zone Engine (Balanced, SPEC-style)
 * - Context TFs: D1 + H4
 * - Execution TFs: H1 + M15
 * - Timing/confirm TF: M5 (adjust confidence + guard)
 *
 * Input (from client):
 * {
 *   symbol: "ETHUSDT",
 *   receivedAt: number,
 *   klinesByTF: { M5:[], M15:[], H1:[], H4:[], D1:[] }
 * }
 */

function hashId(input) {
  return crypto.createHash("sha1").update(input).digest("hex").slice(0, 12);
}

function asNum(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

function sortAscByTime(rows) {
  return rows.slice().sort((a, b) => a.t - b.t);
}

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function normalizeKlines(input) {
  if (!Array.isArray(input)) return [];
  const out = [];
  for (const r of input) {
    const t = asNum(r?.t);
    const o = asNum(r?.o);
    const h = asNum(r?.h);
    const l = asNum(r?.l);
    const c = asNum(r?.c);
    const v = asNum(r?.v ?? 0);
    if (t == null || o == null || h == null || l == null || c == null || v == null) continue;
    out.push({ t, o, h, l, c, v });
  }
  return sortAscByTime(out);
}

/** ---------- Indicators (series O(n)) ---------- */
function emaSeries(values, period) {
  const k = 2 / (period + 1);
  const out = new Array(values.length).fill(null);
  let ema = null;
  for (let i = 0; i < values.length; i++) {
    const x = values[i];
    if (!Number.isFinite(x)) continue;
    ema = ema == null ? x : x * k + ema * (1 - k);
    out[i] = ema;
  }
  return out;
}

function rsiSeries(closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  if (closes.length < period + 2) return out;

  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gain += diff;
    else loss -= diff;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;

  const rs0 = avgLoss === 0 ? 100 : avgGain / avgLoss;
  out[period] = 100 - 100 / (1 + rs0);

  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const g = diff > 0 ? diff : 0;
    const l = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;

    const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
    out[i] = 100 - 100 / (1 + rs);
  }
  return out;
}

function trueRange(prevClose, high, low) {
  if (!Number.isFinite(prevClose)) return high - low;
  return Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
}

function atrSeries(klines, period = 14) {
  const out = new Array(klines.length).fill(null);
  if (klines.length < period + 2) return out;

  const trs = [];
  for (let i = 1; i < klines.length; i++) {
    trs.push(trueRange(klines[i - 1].c, klines[i].h, klines[i].l));
  }

  let sum = 0;
  for (let i = 0; i < period; i++) sum += trs[i];
  let atr = sum / period;
  out[period] = atr;

  for (let i = period + 1; i < klines.length; i++) {
    const tr = trs[i - 1];
    atr = (atr * (period - 1) + tr) / period;
    out[i] = atr;
  }
  return out;
}

/** ---------- Volume Profile (simple & stable) ---------- */
function volumeProfile(klines, bins = 60) {
  if (!klines.length) return null;
  const hi = Math.max(...klines.map((k) => k.h));
  const lo = Math.min(...klines.map((k) => k.l));
  if (!Number.isFinite(hi) || !Number.isFinite(lo) || hi <= lo) return null;

  const step = (hi - lo) / bins;
  const vols = new Array(bins).fill(0);
  const mids = new Array(bins).fill(0);
  for (let i = 0; i < bins; i++) mids[i] = lo + step * (i + 0.5);

  for (const k of klines) {
    const idx = Math.max(0, Math.min(bins - 1, Math.floor((k.c - lo) / step)));
    vols[idx] += Number.isFinite(k.v) ? k.v : 0;
  }

  let pocIdx = 0;
  for (let i = 1; i < bins; i++) if (vols[i] > vols[pocIdx]) pocIdx = i;

  const totalVol = vols.reduce((a, b) => a + b, 0) || 1;
  const target = totalVol * 0.7;

  let left = pocIdx;
  let right = pocIdx;
  let acc = vols[pocIdx];

  while (acc < target && (left > 0 || right < bins - 1)) {
    const nextL = left > 0 ? vols[left - 1] : -1;
    const nextR = right < bins - 1 ? vols[right + 1] : -1;
    if (nextR >= nextL) {
      right++;
      acc += vols[right];
    } else {
      left--;
      acc += vols[left];
    }
  }

  return {
    lo,
    hi,
    step,
    poc: mids[pocIdx],
    val: lo + step * left,
    vah: lo + step * (right + 1),
  };
}

/** ---------- Regime helpers ---------- */
function emaStackLabel(ema20, ema50, ema100, ema200) {
  if (
    ema20 != null &&
    ema50 != null &&
    ema100 != null &&
    ema200 != null &&
    ema20 > ema50 &&
    ema50 > ema100 &&
    ema100 > ema200
  )
    return "bull";
  if (
    ema20 != null &&
    ema50 != null &&
    ema100 != null &&
    ema200 != null &&
    ema20 < ema50 &&
    ema50 < ema100 &&
    ema100 < ema200
  )
    return "bear";
  return "mixed";
}

function trendState({ close, ema20, ema50, rsi, atr }) {
  // Balanced: conservative enough to avoid flip.
  if (close != null && ema20 != null && ema50 != null && rsi != null && atr != null) {
    const nearEma = Math.abs(close - ema20) < 0.5 * atr;
    if (close > ema20 && ema20 > ema50 && rsi >= 55) return "bull";
    if (close < ema20 && ema20 < ema50 && rsi <= 45) return "bear";
    if (nearEma && rsi >= 45 && rsi <= 55) return "range";
  }
  return "neutral";
}

function volatilityRegime(atr, close) {
  if (!Number.isFinite(atr) || !Number.isFinite(close) || close <= 0) return "normal";
  const pct = atr / close;
  if (pct >= 0.02) return "high";
  if (pct <= 0.008) return "low";
  return "normal";
}

function rsiBias(rsi) {
  if (!Number.isFinite(rsi)) return "unknown";
  if (rsi >= 60) return "bull";
  if (rsi <= 40) return "bear";
  return "neutral";
}

/** ---------- Simple swing anchors (SPEC-aligned enough for zones) ---------- */
function swingAnchors(klines, lookback = 60) {
  const slice = klines.slice(-lookback);
  if (!slice.length) return null;
  const lastHigh = Math.max(...slice.map((k) => k.h));
  const lastLow = Math.min(...slice.map((k) => k.l));
  return { lastHigh, lastLow };
}

/** ---------- RR helpers ---------- */
function rrForLong(entry, stop, target) {
  const risk = entry - stop;
  const reward = target - entry;
  if (risk <= 0) return null;
  return reward / risk;
}
function rrForShort(entry, stop, target) {
  const risk = stop - entry;
  const reward = entry - target;
  if (risk <= 0) return null;
  return reward / risk;
}

function tierScore(t) {
  return t === "low" ? 0 : t === "medium" ? 1 : 2;
}

/** ---------- Trade Zone builders (SPEC-style, Balanced triggers) ---------- */
function buildPullbackZone({
  symbol,
  tfLabel,
  direction,
  close,
  atr,
  vp,
  ema20,
  ema50,
  swing,
  htfRegime,
  ltfRegime,
  m5Regime,
  m5Rsi,
  volReg,
  stack,
  rrMin = 1.5,
}) {
  const zones = [];
  const k = volReg === "low" ? 0.4 : volReg === "high" ? 0.7 : 0.5;

  if (direction === "long") {
    const center = Math.max(vp.val, ema50 ?? vp.val);
    const width = k * atr;
    let low = center - width;
    let high = center + width;

    if (Number.isFinite(swing?.lastLow)) low = Math.max(low, swing.lastLow - 0.3 * atr);
    const stop = Number.isFinite(swing?.lastLow) ? swing.lastLow - 0.2 * atr : low - 0.6 * atr;

    const entryRef = clamp(close, low, high);
    const t1 = vp.poc;
    const t2 = Number.isFinite(swing?.lastHigh) ? swing.lastHigh : vp.vah;

    const rr1 = rrForLong(entryRef, stop, t1);
    const rr2 = rrForLong(entryRef, stop, t2);
    if (!((rr1 != null && rr1 >= rrMin) || (rr2 != null && rr2 >= rrMin))) return zones;

    let confidence =
      58 +
      (stack === "bull" ? 10 : stack === "mixed" ? 5 : 0) +
      (volReg === "high" ? -10 : 0) +
      (Number.isFinite(m5Rsi) && m5Rsi <= 45 ? 6 : 0);

    const guards = ["data_stale"];
    if (volReg === "high") guards.push("volatility_high");

    // M5 confirm/guard (Balanced)
    if (m5Regime === "bull") confidence += 6;
    if (m5Regime === "bear") {
      confidence -= 10;
      guards.push("m5_against_direction_wait_confirm");
    }

    zones.push({
      id: hashId(`${symbol}:${tfLabel}:pullback_long:${low.toFixed(2)}:${high.toFixed(2)}`),
      symbol,
      tf: tfLabel,
      direction: "long",
      type: "pullback_entry",
      zone: { low, high },
      triggers: [
        { type: "price_into_zone", rule: "Price trades into zone band" },
        { type: "close_confirm", rule: "Close reclaims EMA20 or VAL (Balanced confirm)" },
      ],
      invalidation: { type: "hard_stop", level: stop, rule: "Stop below swing low / zone low buffer" },
      targets: [
        { level: t1, label: "T1", basis: "vp" },
        { level: t2, label: "T2", basis: Number.isFinite(swing?.lastHigh) ? "swing" : "vp" },
      ],
      risk: {
        tier: volReg === "high" ? "high" : "medium",
        rrMin,
        stopDistanceAtr: (entryRef - stop) / atr,
        volatilityRegime: volReg,
      },
      confidence: clamp(confidence, 0, 100),
      rationale: {
        bullets: [
          `Context=pullback (HTF ${htfRegime}, LTF ${ltfRegime})`,
          `Anchors: VAL=${vp.val.toFixed(2)} / EMA50=${ema50?.toFixed?.(2) ?? "n/a"} / POC=${vp.poc.toFixed(2)}`,
          `M5 timing: ${m5Regime} (adjusts confidence/guards)`,
        ],
        facts: {
          close,
          atr,
          ema20: ema20 ?? null,
          ema50: ema50 ?? null,
          poc: vp.poc,
          val: vp.val,
          vah: vp.vah,
          htfRegime,
          ltfRegime,
          m5Regime,
          m5Rsi: m5Rsi ?? null,
          emaStack: stack,
        },
      },
      guards: { noTradeIf: guards, expiresAt: Date.now() + 2 * 60 * 60 * 1000 },
    });
  }

  if (direction === "short") {
    const center = Math.min(vp.vah, ema50 ?? vp.vah);
    const width = k * atr;
    let low = center - width;
    let high = center + width;

    if (Number.isFinite(swing?.lastHigh)) high = Math.min(high, swing.lastHigh + 0.3 * atr);
    const stop = Number.isFinite(swing?.lastHigh) ? swing.lastHigh + 0.2 * atr : high + 0.6 * atr;

    const entryRef = clamp(close, low, high);
    const t1 = vp.poc;
    const t2 = Number.isFinite(swing?.lastLow) ? swing.lastLow : vp.val;

    const rr1 = rrForShort(entryRef, stop, t1);
    const rr2 = rrForShort(entryRef, stop, t2);
    if (!((rr1 != null && rr1 >= rrMin) || (rr2 != null && rr2 >= rrMin))) return zones;

    let confidence =
      58 +
      (stack === "bear" ? 10 : stack === "mixed" ? 5 : 0) +
      (volReg === "high" ? -10 : 0) +
      (Number.isFinite(m5Rsi) && m5Rsi >= 55 ? 6 : 0);

    const guards = ["data_stale"];
    if (volReg === "high") guards.push("volatility_high");

    if (m5Regime === "bear") confidence += 6;
    if (m5Regime === "bull") {
      confidence -= 10;
      guards.push("m5_against_direction_wait_confirm");
    }

    zones.push({
      id: hashId(`${symbol}:${tfLabel}:pullback_short:${low.toFixed(2)}:${high.toFixed(2)}`),
      symbol,
      tf: tfLabel,
      direction: "short",
      type: "pullback_entry",
      zone: { low, high },
      triggers: [
        { type: "price_into_zone", rule: "Price trades into zone band" },
        { type: "close_confirm", rule: "Close loses EMA20 or falls back under VAH (Balanced confirm)" },
      ],
      invalidation: { type: "hard_stop", level: stop, rule: "Stop above swing high / zone high buffer" },
      targets: [
        { level: t1, label: "T1", basis: "vp" },
        { level: t2, label: "T2", basis: Number.isFinite(swing?.lastLow) ? "swing" : "vp" },
      ],
      risk: {
        tier: volReg === "high" ? "high" : "medium",
        rrMin,
        stopDistanceAtr: (stop - entryRef) / atr,
        volatilityRegime: volReg,
      },
      confidence: clamp(confidence, 0, 100),
      rationale: {
        bullets: [
          `Context=pullback (HTF ${htfRegime}, LTF ${ltfRegime})`,
          `Anchors: VAH=${vp.vah.toFixed(2)} / EMA50=${ema50?.toFixed?.(2) ?? "n/a"} / POC=${vp.poc.toFixed(2)}`,
          `M5 timing: ${m5Regime} (adjusts confidence/guards)`,
        ],
        facts: {
          close,
          atr,
          ema20: ema20 ?? null,
          ema50: ema50 ?? null,
          poc: vp.poc,
          val: vp.val,
          vah: vp.vah,
          htfRegime,
          ltfRegime,
          m5Regime,
          m5Rsi: m5Rsi ?? null,
          emaStack: stack,
        },
      },
      guards: { noTradeIf: guards, expiresAt: Date.now() + 2 * 60 * 60 * 1000 },
    });
  }

  return zones;
}

function buildRangeZones({
  symbol,
  tfLabel,
  close,
  atr,
  vp,
  htfRegime,
  ltfRegime,
  m5Regime,
  m5Rsi,
  volReg,
  rrMin = 1.5,
}) {
  const zones = [];
  const width = 0.5 * atr;

  // Long near VAL
  {
    const center = vp.val;
    const low = center - width;
    const high = center + width;
    const stop = low - 0.6 * atr;
    const entry = clamp(close, low, high);
    const rr = rrForLong(entry, stop, vp.poc);
    if (rr != null && rr >= rrMin) {
      let confidence = 52 + (volReg === "low" ? 8 : 0) + (volReg === "high" ? -8 : 0);
      const guards = ["data_stale"];
      if (m5Regime === "bull") confidence += 4;
      if (m5Regime === "bear") {
        confidence -= 6;
        guards.push("m5_against_direction_wait_confirm");
      }

      zones.push({
        id: hashId(`${symbol}:${tfLabel}:range_long:${low.toFixed(2)}:${high.toFixed(2)}`),
        symbol,
        tf: tfLabel,
        direction: "long",
        type: "range_extreme",
        zone: { low, high },
        triggers: [
          { type: "price_into_zone", rule: "Price into VAL band" },
          { type: "close_confirm", rule: "Close prints higher-low or RSI rebounds > 40 (Balanced)" },
        ],
        invalidation: { type: "hard_stop", level: stop, rule: "Stop below VAL band buffer" },
        targets: [{ level: vp.poc, label: "T1", basis: "vp" }],
        risk: {
          tier: volReg === "high" ? "high" : "medium",
          rrMin,
          stopDistanceAtr: (entry - stop) / atr,
          volatilityRegime: volReg,
        },
        confidence: clamp(confidence, 0, 100),
        rationale: {
          bullets: [
            `Context=range (HTF ${htfRegime})`,
            `VAL=${vp.val.toFixed(2)} → mean reversion to POC=${vp.poc.toFixed(2)}`,
            `M5 timing: ${m5Regime}`,
          ],
          facts: { close, atr, poc: vp.poc, val: vp.val, vah: vp.vah, htfRegime, ltfRegime, m5Regime, m5Rsi: m5Rsi ?? null },
        },
        guards: { noTradeIf: guards, expiresAt: Date.now() + 2 * 60 * 60 * 1000 },
      });
    }
  }

  // Short near VAH
  {
    const center = vp.vah;
    const low = center - width;
    const high = center + width;
    const stop = high + 0.6 * atr;
    const entry = clamp(close, low, high);
    const rr = rrForShort(entry, stop, vp.poc);
    if (rr != null && rr >= rrMin) {
      let confidence = 52 + (volReg === "low" ? 8 : 0) + (volReg === "high" ? -8 : 0);
      const guards = ["data_stale"];
      if (m5Regime === "bear") confidence += 4;
      if (m5Regime === "bull") {
        confidence -= 6;
        guards.push("m5_against_direction_wait_confirm");
      }

      zones.push({
        id: hashId(`${symbol}:${tfLabel}:range_short:${low.toFixed(2)}:${high.toFixed(2)}`),
        symbol,
        tf: tfLabel,
        direction: "short",
        type: "range_extreme",
        zone: { low, high },
        triggers: [
          { type: "price_into_zone", rule: "Price into VAH band" },
          { type: "close_confirm", rule: "Close prints lower-high or RSI rolls < 60 (Balanced)" },
        ],
        invalidation: { type: "hard_stop", level: stop, rule: "Stop above VAH band buffer" },
        targets: [{ level: vp.poc, label: "T1", basis: "vp" }],
        risk: {
          tier: volReg === "high" ? "high" : "medium",
          rrMin,
          stopDistanceAtr: (stop - entry) / atr,
          volatilityRegime: volReg,
        },
        confidence: clamp(confidence, 0, 100),
        rationale: {
          bullets: [
            `Context=range (HTF ${htfRegime})`,
            `VAH=${vp.vah.toFixed(2)} → mean reversion to POC=${vp.poc.toFixed(2)}`,
            `M5 timing: ${m5Regime}`,
          ],
          facts: { close, atr, poc: vp.poc, val: vp.val, vah: vp.vah, htfRegime, ltfRegime, m5Regime, m5Rsi: m5Rsi ?? null },
        },
        guards: { noTradeIf: guards, expiresAt: Date.now() + 2 * 60 * 60 * 1000 },
      });
    }
  }

  return zones;
}

/** ---------- Build features per TF ---------- */
function buildTFState(klines, { vpLookback = 220 } = {}) {
  const closes = klines.map((k) => k.c);
  const ema20 = emaSeries(closes, 20);
  const ema50 = emaSeries(closes, 50);
  const ema100 = emaSeries(closes, 100);
  const ema200 = emaSeries(closes, 200);
  const rsi = rsiSeries(closes, 14);
  const atr = atrSeries(klines, 14);

  const last = klines.length - 1;
  const close = closes[last];
  const rsiLast = rsi[last];
  const atrLast = atr[last];

  const vp = volumeProfile(klines.slice(-vpLookback), 60);
  const swing = swingAnchors(klines, 60);

  const state = {
    close,
    ema20: ema20[last],
    ema50: ema50[last],
    ema100: ema100[last],
    ema200: ema200[last],
    rsi: rsiLast,
    atr: atrLast,
    rsiBias: rsiBias(rsiLast),
    emaStack: emaStackLabel(ema20[last], ema50[last], ema100[last], ema200[last]),
    vp,
    swing,
  };

  state.regime = trendState({ close: state.close, ema20: state.ema20, ema50: state.ema50, rsi: state.rsi, atr: state.atr });
  state.volReg = volatilityRegime(state.atr, state.close);

  return state;
}

/** ---------- Context resolver (SPEC-like) ---------- */
function resolveContext(htfRegime, ltfRegime) {
  if ((htfRegime === "bull" && ltfRegime === "bull") || (htfRegime === "bear" && ltfRegime === "bear")) return "trend";
  if (htfRegime === "bull" && (ltfRegime === "bear" || ltfRegime === "neutral")) return "pullback";
  if (htfRegime === "bear" && (ltfRegime === "bull" || ltfRegime === "neutral")) return "pullback";
  if (htfRegime === "range") return "range";
  return "range";
}

/** ---------- Public API ---------- */
export function generateTradeZonesMultiTFFromClientData({
  symbol = "ETHUSDT",
  klinesByTF = {},
  receivedAt = Date.now(),
}) {
  const generatedAt = Date.now();

  // Normalize
  const M5 = normalizeKlines(klinesByTF.M5);
  const M15 = normalizeKlines(klinesByTF.M15);
  const H1 = normalizeKlines(klinesByTF.H1);
  const H4 = normalizeKlines(klinesByTF.H4);
  const D1 = normalizeKlines(klinesByTF.D1);

  const warnings = [];
  const min = { M5: 200, M15: 200, H1: 200, H4: 160, D1: 120 };

  if (M15.length < min.M15) warnings.push("insufficient_klines_M15");
  if (H1.length < min.H1) warnings.push("insufficient_klines_H1");
  if (H4.length < min.H4) warnings.push("insufficient_klines_H4");
  if (M5.length < min.M5) warnings.push("insufficient_klines_M5");
  // D1 optional; only warn if present but too short
  if (D1.length > 0 && D1.length < min.D1) warnings.push("insufficient_klines_D1");

  // Need at least H4 + (H1 or M15) + M5 for “SPEC-like confirm”
  if (H4.length < min.H4 || (H1.length < min.H1 && M15.length < min.M15) || M5.length < min.M5) {
    return { meta: { symbol, venue: "bybit", generatedAt, receivedAt, warnings }, tradeZones: [], report: null };
  }

  // Build TF states
  const stM5 = buildTFState(M5, { vpLookback: 260 });
  const stM15 = buildTFState(M15, { vpLookback: 240 });
  const stH1 = buildTFState(H1, { vpLookback: 220 });
  const stH4 = buildTFState(H4, { vpLookback: 220 });
  const stD1 = D1.length >= min.D1 ? buildTFState(D1, { vpLookback: 180 }) : null;

  // HTF context: prefer D1 if available, else H4
  const htf = stD1 ? { tf: "D1", state: stD1 } : { tf: "H4", state: stH4 };
  const htfRegime = htf.state.regime;

  // Execution TFs: H1 and M15
  const zones = [];

  // Context per exec TF
  const ctxH1 = resolveContext(htfRegime, stH1.regime);
  const ctxM15 = resolveContext(htfRegime, stM15.regime);

  // Pullback/Range zones for H1
  if (stH1.vp && Number.isFinite(stH1.atr) && Number.isFinite(stH1.close)) {
    if (ctxH1 === "pullback") {
      if (htfRegime === "bull") zones.push(...buildPullbackZone({
        symbol, tfLabel: "H1", direction: "long",
        close: stH1.close, atr: stH1.atr, vp: stH1.vp, ema20: stH1.ema20, ema50: stH1.ema50,
        swing: stH1.swing, htfRegime, ltfRegime: stH1.regime,
        m5Regime: stM5.regime, m5Rsi: stM5.rsi, volReg: stH1.volReg, stack: stH1.emaStack,
      }));
      if (htfRegime === "bear") zones.push(...buildPullbackZone({
        symbol, tfLabel: "H1", direction: "short",
        close: stH1.close, atr: stH1.atr, vp: stH1.vp, ema20: stH1.ema20, ema50: stH1.ema50,
        swing: stH1.swing, htfRegime, ltfRegime: stH1.regime,
        m5Regime: stM5.regime, m5Rsi: stM5.rsi, volReg: stH1.volReg, stack: stH1.emaStack,
      }));
    } else if (ctxH1 === "range") {
      zones.push(...buildRangeZones({
        symbol, tfLabel: "H1",
        close: stH1.close, atr: stH1.atr, vp: stH1.vp,
        htfRegime, ltfRegime: stH1.regime, m5Regime: stM5.regime, m5Rsi: stM5.rsi, volReg: stH1.volReg,
      }));
    }
  }

  // Pullback/Range zones for M15 (often primary execution)
  if (stM15.vp && Number.isFinite(stM15.atr) && Number.isFinite(stM15.close)) {
    if (ctxM15 === "pullback") {
      if (htfRegime === "bull") zones.push(...buildPullbackZone({
        symbol, tfLabel: "M15", direction: "long",
        close: stM15.close, atr: stM15.atr, vp: stM15.vp, ema20: stM15.ema20, ema50: stM15.ema50,
        swing: stM15.swing, htfRegime, ltfRegime: stM15.regime,
        m5Regime: stM5.regime, m5Rsi: stM5.rsi, volReg: stM15.volReg, stack: stM15.emaStack,
      }));
      if (htfRegime === "bear") zones.push(...buildPullbackZone({
        symbol, tfLabel: "M15", direction: "short",
        close: stM15.close, atr: stM15.atr, vp: stM15.vp, ema20: stM15.ema20, ema50: stM15.ema50,
        swing: stM15.swing, htfRegime, ltfRegime: stM15.regime,
        m5Regime: stM5.regime, m5Rsi: stM5.rsi, volReg: stM15.volReg, stack: stM15.emaStack,
      }));
    } else if (ctxM15 === "range") {
      zones.push(...buildRangeZones({
        symbol, tfLabel: "M15",
        close: stM15.close, atr: stM15.atr, vp: stM15.vp,
        htfRegime, ltfRegime: stM15.regime, m5Regime: stM5.regime, m5Rsi: stM5.rsi, volReg: stM15.volReg,
      }));
    }
  }

  // Rank & cap (SPEC-like)
  zones.sort((a, b) => {
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    return tierScore(a.risk.tier) - tierScore(b.risk.tier);
  });

  const tradeZones = zones.slice(0, 7);

  const report = {
    htf: { tf: htf.tf, regime: htfRegime, rsi: htf.state.rsi, emaStack: htf.state.emaStack },
    tf: {
      M5: { regime: stM5.regime, rsi: stM5.rsi, emaStack: stM5.emaStack },
      M15: { regime: stM15.regime, rsi: stM15.rsi, emaStack: stM15.emaStack, vp: stM15.vp },
      H1: { regime: stH1.regime, rsi: stH1.rsi, emaStack: stH1.emaStack, vp: stH1.vp },
      H4: { regime: stH4.regime, rsi: stH4.rsi, emaStack: stH4.emaStack },
      D1: stD1 ? { regime: stD1.regime, rsi: stD1.rsi, emaStack: stD1.emaStack } : null,
    },
    contexts: { H1: ctxH1, M15: ctxM15 },
  };

  return {
    meta: { symbol, venue: "bybit", generatedAt, receivedAt, warnings },
    report,
    tradeZones,
  };
}
