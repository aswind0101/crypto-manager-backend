// crypto-manager-backend/services/tradeZoneEngine.js
import axios from "axios";
import crypto from "crypto";

const BYBIT_BASE = "https://api.bybit.com";

/** ---------- Bybit REST client ---------- */
async function getFromBybit(path, params = {}) {
  const url = new URL(path, BYBIT_BASE);
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null) url.searchParams.append(k, String(v));
  });

  const { data } = await axios.get(url.toString(), {
    timeout: 10000,
    headers: { "User-Agent": "crypto-manager-tradezone/1.0" },
  });

  if (data?.retCode !== 0) {
    throw new Error(`Bybit retCode ${data?.retCode}: ${data?.retMsg}`);
  }
  return data.result || {};
}

async function getKlines(symbol, interval, limit = 300) {
  const result = await getFromBybit("/v5/market/kline", {
    category: "linear",
    symbol,
    interval,
    limit,
  });
  // Bybit list: [startTime, open, high, low, close, volume, turnover]
  return (result.list || []).map((r) => ({
    t: Number(r[0]),
    o: Number(r[1]),
    h: Number(r[2]),
    l: Number(r[3]),
    c: Number(r[4]),
    v: Number(r[5]),
  }));
}

/** ---------- Timeframe mapping ---------- */
const TF = {
  M5: "5",
  M15: "15",
  H1: "60",
  H4: "240",
  D1: "D",
};

function sortAscByTime(rows) {
  return rows.slice().sort((a, b) => a.t - b.t);
}

/** ---------- Indicators (series O(n)) ---------- */
function emaSeries(values, period) {
  const k = 2 / (period + 1);
  const out = new Array(values.length).fill(null);
  let ema = null;

  for (let i = 0; i < values.length; i++) {
    const x = values[i];
    if (!Number.isFinite(x)) continue;

    if (ema == null) {
      ema = x; // seed
    } else {
      ema = x * k + ema * (1 - k);
    }
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
  return Math.max(
    high - low,
    Math.abs(high - prevClose),
    Math.abs(low - prevClose)
  );
}

function atrSeries(klines, period = 14) {
  const out = new Array(klines.length).fill(null);
  if (klines.length < period + 2) return out;

  const trs = [];
  for (let i = 1; i < klines.length; i++) {
    trs.push(trueRange(klines[i - 1].c, klines[i].h, klines[i].l));
  }

  // seed: SMA TR
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

/** ---------- Volume Profile (simple) ---------- */
// Bin by price step = (range / bins). Compute POC & value area ~70% by volume.
function volumeProfile(klines, bins = 48) {
  if (!klines.length) return null;
  const highs = klines.map((k) => k.h);
  const lows = klines.map((k) => k.l);
  const hi = Math.max(...highs);
  const lo = Math.min(...lows);
  if (!Number.isFinite(hi) || !Number.isFinite(lo) || hi <= lo) return null;

  const step = (hi - lo) / bins;
  const vols = new Array(bins).fill(0);
  const mids = new Array(bins).fill(0);

  for (let i = 0; i < bins; i++) mids[i] = lo + step * (i + 0.5);

  // allocate candle volume to nearest mid by close price (simple + stable)
  for (const k of klines) {
    const idx = Math.max(
      0,
      Math.min(bins - 1, Math.floor((k.c - lo) / step))
    );
    vols[idx] += Number.isFinite(k.v) ? k.v : 0;
  }

  let pocIdx = 0;
  for (let i = 1; i < bins; i++) if (vols[i] > vols[pocIdx]) pocIdx = i;

  const totalVol = vols.reduce((a, b) => a + b, 0) || 1;
  const target = totalVol * 0.7;

  // expand value area from POC outward
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

  const poc = mids[pocIdx];
  const val = lo + step * left; // low edge
  const vah = lo + step * (right + 1); // high edge

  return { lo, hi, step, poc, val, vah };
}

/** ---------- Regime / Context ---------- */
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
  // Balanced thresholds: avoid flip; requires a minimum momentum proxy
  if (
    close != null &&
    ema20 != null &&
    ema50 != null &&
    rsi != null &&
    atr != null
  ) {
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

/** ---------- Trade Zone generation (Balanced) ---------- */
function hashId(input) {
  return crypto.createHash("sha1").update(input).digest("hex").slice(0, 12);
}

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

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function buildTradeZones({ symbol, tfLabel, features }) {
  const {
    close,
    ema20,
    ema50,
    ema100,
    ema200,
    rsi,
    atr,
    vp, // {poc,val,vah}
    swing, // {lastHigh,lastLow} optional
    regime, // bull/bear/range/neutral
    htfRegime, // bull/bear/range/neutral
  } = features;

  const zones = [];
  if (!Number.isFinite(close) || !Number.isFinite(atr) || !vp) return zones;

  const volReg = volatilityRegime(atr, close);
  const stack = emaStackLabel(ema20, ema50, ema100, ema200);

  // Determine context
  let context = "range";
  if ((htfRegime === "bull" && regime === "bull") || (htfRegime === "bear" && regime === "bear")) context = "trend";
  if (htfRegime === "bull" && (regime === "bear" || regime === "neutral")) context = "pullback";
  if (htfRegime === "bear" && (regime === "bull" || regime === "neutral")) context = "pullback";
  if (htfRegime === "range") context = "range";

  // Anchor helpers
  const swingLow = swing?.lastLow ?? null;
  const swingHigh = swing?.lastHigh ?? null;

  // Balanced width: 0.5 ATR default; narrower in low vol, wider in high vol
  const k = volReg === "low" ? 0.4 : volReg === "high" ? 0.7 : 0.5;

  /** ---- 1) Pullback Entry Zone ---- */
  if (context === "pullback") {
    // Long pullback when HTF bull
    if (htfRegime === "bull") {
      const center = Math.max(vp.val, ema50 ?? vp.val);
      const width = k * atr;
      let low = center - width;
      let high = center + width;

      // clamp: do not set zone below swingLow too much (avoid chasing knife)
      if (Number.isFinite(swingLow)) low = Math.max(low, swingLow - 0.3 * atr);

      const stop = Number.isFinite(swingLow) ? swingLow - 0.2 * atr : low - 0.6 * atr;

      const entryRef = clamp(close, low, high);
      const t1 = vp.poc;
      const t2 = Number.isFinite(swingHigh) ? swingHigh : vp.vah;

      const rr1 = rrForLong(entryRef, stop, t1);
      const rr2 = rrForLong(entryRef, stop, t2);

      const rrMin = 1.5;
      if ((rr1 != null && rr1 >= rrMin) || (rr2 != null && rr2 >= rrMin)) {
        const confidence =
          55 +
          (stack === "bull" ? 10 : stack === "mixed" ? 5 : 0) +
          (volReg === "high" ? -10 : 0) +
          (rsi != null && rsi <= 45 ? 8 : 0);

        zones.push({
          id: hashId(`${symbol}:${tfLabel}:pullback_long:${low.toFixed(2)}:${high.toFixed(2)}`),
          symbol,
          tf: tfLabel,
          direction: "long",
          type: "pullback_entry",
          zone: { low, high },
          triggers: [
            { type: "price_into_zone", rule: "Price trades into zone band" },
            { type: "close_confirm", rule: "Close reclaims EMA20 or VAL" },
          ],
          invalidation: {
            type: "hard_stop",
            level: stop,
            rule: "Hard stop below swing low / zone low buffer",
          },
          targets: [
            { level: t1, label: "T1", basis: "vp" },
            { level: t2, label: "T2", basis: Number.isFinite(swingHigh) ? "swing" : "vp" },
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
              `Context=pullback (HTF bull, LTF not bull)`,
              `Anchors: VAL=${vp.val.toFixed(2)} / EMA50=${ema50?.toFixed?.(2) ?? "n/a"} / POC=${vp.poc.toFixed(2)}`,
              `Trigger requires close confirmation (Balanced)`,
            ],
            facts: {
              close,
              atr,
              rsi: rsi ?? null,
              ema20: ema20 ?? null,
              ema50: ema50 ?? null,
              poc: vp.poc,
              val: vp.val,
              vah: vp.vah,
              htfRegime,
              regime,
              emaStack: stack,
            },
          },
          guards: {
            noTradeIf: [
              "data_stale",
              volReg === "high" ? "volatility_high" : "",
            ].filter(Boolean),
            expiresAt: Date.now() + 2 * 60 * 60 * 1000, // 2h default
          },
        });
      }
    }

    // Short pullback when HTF bear
    if (htfRegime === "bear") {
      const center = Math.min(vp.vah, ema50 ?? vp.vah);
      const width = k * atr;
      let low = center - width;
      let high = center + width;

      if (Number.isFinite(swingHigh)) high = Math.min(high, swingHigh + 0.3 * atr);

      const stop = Number.isFinite(swingHigh) ? swingHigh + 0.2 * atr : high + 0.6 * atr;

      const entryRef = clamp(close, low, high);
      const t1 = vp.poc;
      const t2 = Number.isFinite(swingLow) ? swingLow : vp.val;

      const rr1 = rrForShort(entryRef, stop, t1);
      const rr2 = rrForShort(entryRef, stop, t2);

      const rrMin = 1.5;
      if ((rr1 != null && rr1 >= rrMin) || (rr2 != null && rr2 >= rrMin)) {
        const confidence =
          55 +
          (stack === "bear" ? 10 : stack === "mixed" ? 5 : 0) +
          (volReg === "high" ? -10 : 0) +
          (rsi != null && rsi >= 55 ? 8 : 0);

        zones.push({
          id: hashId(`${symbol}:${tfLabel}:pullback_short:${low.toFixed(2)}:${high.toFixed(2)}`),
          symbol,
          tf: tfLabel,
          direction: "short",
          type: "pullback_entry",
          zone: { low, high },
          triggers: [
            { type: "price_into_zone", rule: "Price trades into zone band" },
            { type: "close_confirm", rule: "Close loses EMA20 or falls back under VAH" },
          ],
          invalidation: {
            type: "hard_stop",
            level: stop,
            rule: "Hard stop above swing high / zone high buffer",
          },
          targets: [
            { level: t1, label: "T1", basis: "vp" },
            { level: t2, label: "T2", basis: Number.isFinite(swingLow) ? "swing" : "vp" },
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
              `Context=pullback (HTF bear, LTF not bear)`,
              `Anchors: VAH=${vp.vah.toFixed(2)} / EMA50=${ema50?.toFixed?.(2) ?? "n/a"} / POC=${vp.poc.toFixed(2)}`,
              `Trigger requires close confirmation (Balanced)`,
            ],
            facts: {
              close,
              atr,
              rsi: rsi ?? null,
              ema20: ema20 ?? null,
              ema50: ema50 ?? null,
              poc: vp.poc,
              val: vp.val,
              vah: vp.vah,
              htfRegime,
              regime,
              emaStack: stack,
            },
          },
          guards: {
            noTradeIf: [
              "data_stale",
              volReg === "high" ? "volatility_high" : "",
            ].filter(Boolean),
            expiresAt: Date.now() + 2 * 60 * 60 * 1000,
          },
        });
      }
    }
  }

  /** ---- 2) Range Extreme Zone (mean reversion) ---- */
  if (context === "range") {
    // Long near VAL
    const centerL = vp.val;
    const widthL = 0.5 * atr;
    const lowL = centerL - widthL;
    const highL = centerL + widthL;
    const stopL = lowL - 0.6 * atr;
    const entryL = clamp(close, lowL, highL);
    const rrL = rrForLong(entryL, stopL, vp.poc);
    if (rrL != null && rrL >= 1.5) {
      zones.push({
        id: hashId(`${symbol}:${tfLabel}:range_long:${lowL.toFixed(2)}:${highL.toFixed(2)}`),
        symbol,
        tf: tfLabel,
        direction: "long",
        type: "range_extreme",
        zone: { low: lowL, high: highL },
        triggers: [
          { type: "price_into_zone", rule: "Price into VAL band" },
          { type: "close_confirm", rule: "Close prints higher-low or RSI rebounds > 40" },
        ],
        invalidation: { type: "hard_stop", level: stopL, rule: "Stop below VAL band buffer" },
        targets: [{ level: vp.poc, label: "T1", basis: "vp" }],
        risk: {
          tier: volReg === "high" ? "high" : "medium",
          rrMin: 1.5,
          stopDistanceAtr: (entryL - stopL) / atr,
          volatilityRegime: volReg,
        },
        confidence: clamp(50 + (volReg === "low" ? 8 : 0), 0, 100),
        rationale: {
          bullets: [
            "Context=range (mean reversion)",
            `Buy extreme near VAL with confirm (Balanced)`,
          ],
          facts: { close, atr, poc: vp.poc, val: vp.val, vah: vp.vah, regime, htfRegime },
        },
        guards: { noTradeIf: ["data_stale"], expiresAt: Date.now() + 2 * 60 * 60 * 1000 },
      });
    }

    // Short near VAH
    const centerS = vp.vah;
    const widthS = 0.5 * atr;
    const lowS = centerS - widthS;
    const highS = centerS + widthS;
    const stopS = highS + 0.6 * atr;
    const entryS = clamp(close, lowS, highS);
    const rrS = rrForShort(entryS, stopS, vp.poc);
    if (rrS != null && rrS >= 1.5) {
      zones.push({
        id: hashId(`${symbol}:${tfLabel}:range_short:${lowS.toFixed(2)}:${highS.toFixed(2)}`),
        symbol,
        tf: tfLabel,
        direction: "short",
        type: "range_extreme",
        zone: { low: lowS, high: highS },
        triggers: [
          { type: "price_into_zone", rule: "Price into VAH band" },
          { type: "close_confirm", rule: "Close prints lower-high or RSI rolls < 60" },
        ],
        invalidation: { type: "hard_stop", level: stopS, rule: "Stop above VAH band buffer" },
        targets: [{ level: vp.poc, label: "T1", basis: "vp" }],
        risk: {
          tier: volReg === "high" ? "high" : "medium",
          rrMin: 1.5,
          stopDistanceAtr: (stopS - entryS) / atr,
          volatilityRegime: volReg,
        },
        confidence: clamp(50 + (volReg === "low" ? 8 : 0), 0, 100),
        rationale: {
          bullets: [
            "Context=range (mean reversion)",
            `Sell extreme near VAH with confirm (Balanced)`,
          ],
          facts: { close, atr, poc: vp.poc, val: vp.val, vah: vp.vah, regime, htfRegime },
        },
        guards: { noTradeIf: ["data_stale"], expiresAt: Date.now() + 2 * 60 * 60 * 1000 },
      });
    }
  }

  // Rank: confidence desc, then lower risk tier
  const tierScore = (t) => (t === "low" ? 0 : t === "medium" ? 1 : 2);
  zones.sort((a, b) => {
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    return tierScore(a.risk.tier) - tierScore(b.risk.tier);
  });

  // Keep top 5
  return zones.slice(0, 5);
}

/** ---------- Public API: analyze & generate trade zones ---------- */
export async function generateTradeZonesForSymbol(symbol = "ETHUSDT") {
  const generatedAt = Date.now();

  // Load klines for LTF + HTF
  const [m15Raw, h4Raw] = await Promise.all([
    getKlines(symbol, TF.M15, 300),
    getKlines(symbol, TF.H4, 300),
  ]);

  const m15 = sortAscByTime(m15Raw);
  const h4 = sortAscByTime(h4Raw);

  if (m15.length < 120 || h4.length < 120) {
    return {
      meta: { symbol, generatedAt, warnings: ["insufficient_klines"] },
      tradeZones: [],
    };
  }

  const closesM15 = m15.map((k) => k.c);
  const closesH4 = h4.map((k) => k.c);

  const ema20M15 = emaSeries(closesM15, 20);
  const ema50M15 = emaSeries(closesM15, 50);
  const ema100M15 = emaSeries(closesM15, 100);
  const ema200M15 = emaSeries(closesM15, 200);
  const rsiM15 = rsiSeries(closesM15, 14);
  const atrM15 = atrSeries(m15, 14);

  const ema20H4 = emaSeries(closesH4, 20);
  const ema50H4 = emaSeries(closesH4, 50);
  const ema100H4 = emaSeries(closesH4, 100);
  const ema200H4 = emaSeries(closesH4, 200);
  const rsiH4 = rsiSeries(closesH4, 14);
  const atrH4 = atrSeries(h4, 14);

  const lastM15 = m15.length - 1;
  const lastH4 = h4.length - 1;

  const vpM15 = volumeProfile(m15.slice(-200), 48);
  const vpH4 = volumeProfile(h4.slice(-200), 48);

  const closeM15 = closesM15[lastM15];
  const closeH4 = closesH4[lastH4];

  const regimeH4 = trendState({
    close: closeH4,
    ema20: ema20H4[lastH4],
    ema50: ema50H4[lastH4],
    rsi: rsiH4[lastH4],
    atr: atrH4[lastH4],
  });

  const regimeM15 = trendState({
    close: closeM15,
    ema20: ema20M15[lastM15],
    ema50: ema50M15[lastM15],
    rsi: rsiM15[lastM15],
    atr: atrM15[lastM15],
  });

  // Minimal swing anchors (simple): last 20-bar high/low
  const lookback = 40;
  const recent = m15.slice(-lookback);
  const lastHigh = Math.max(...recent.map((k) => k.h));
  const lastLow = Math.min(...recent.map((k) => k.l));

  const featuresM15 = {
    close: closeM15,
    ema20: ema20M15[lastM15],
    ema50: ema50M15[lastM15],
    ema100: ema100M15[lastM15],
    ema200: ema200M15[lastM15],
    rsi: rsiM15[lastM15],
    atr: atrM15[lastM15],
    vp: vpM15,
    swing: { lastHigh, lastLow },
    regime: regimeM15,
    htfRegime: regimeH4,
  };

  const tradeZones = buildTradeZones({
    symbol,
    tfLabel: "M15",
    features: featuresM15,
  });

  return {
    meta: {
      symbol,
      venue: "bybit",
      generatedAt,
      regimes: { H4: regimeH4, M15: regimeM15 },
      warnings: [],
    },
    // Optional debug facts for UI
    snapshot: {
      M15: {
        close: closeM15,
        rsi: rsiM15[lastM15],
        atr: atrM15[lastM15],
        vp: vpM15,
      },
      H4: {
        close: closeH4,
        rsi: rsiH4[lastH4],
        atr: atrH4[lastH4],
        vp: vpH4,
      },
    },
    tradeZones,
  };
}
