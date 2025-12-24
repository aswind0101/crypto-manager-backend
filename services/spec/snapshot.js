// crypto-manager-backend/services/spec/snapshot.js
import { tfToMs, computeLastClosed, gapReport, gradeDataQuality } from "./normalize.js";
import { emaSeries, rsiSeries, atrSeries, adxSeries, bb20_2, computeSwings, computeRegime, computeVolumeProfile } from "./compute.js";

function lastClosedCandle(klines, lastClosedTs) {
  if (!klines || !lastClosedTs) return null;
  for (let i = klines.length - 1; i >= 0; i--) {
    if (Number(klines[i].t) === Number(lastClosedTs)) {
      const k = klines[i];
      return { ts: k.t, o: k.o, h: k.h, l: k.l, c: k.c, v: k.v ?? 0 };
    }
  }
  return null;
}

function slopeOf(series, lookback = 5) {
  if (!series || series.length < lookback + 1) return null;
  const a = series[series.length - 1];
  const b = series[series.length - 1 - lookback];
  if (a == null || b == null) return null;
  return a - b;
}

export function buildSnapshotInternalFull({
  symbol,
  nowTs,
  raw = {},
  klinesByTF = {}, // keys: "5","15","60","240","D"
}) {
  const tfs = ["5", "15", "60", "240", "D"];

  const norm = {};
  const tfMeta = {};
  const gapByTF = {};
  const barsByTF = {};

  for (const tf of tfs) {
    const tfMs = tfToMs(tf);
    const kl = (klinesByTF[tf] || []);
    const sorted = (kl || []).slice().sort((a, b) => Number(a.t) - Number(b.t));

    // sanitize numeric
    const clean = sorted.map((k) => ({
      t: Number(k.t),
      o: Number(k.o),
      h: Number(k.h),
      l: Number(k.l),
      c: Number(k.c),
      v: Number(k.v ?? 0),
    })).filter((k) => Number.isFinite(k.t) && Number.isFinite(k.c));

    norm[tf] = clean;

    const lc = computeLastClosed(clean, tfMs, nowTs);
    tfMeta[tf] = { ms: tfMs, bars: clean.length, ...lc };
    barsByTF[tf] = clean.length;
    gapByTF[tf] = gapReport(clean, tfMs);
  }

  const dq = gradeDataQuality({ barsByTF, gapByTF, requiredBars: 220 });

  // Indicators per TF
  const indicators = {};
  const volume_profile = {};
  const price_structure = {};

  for (const tf of tfs) {
    const kl = norm[tf];
    const lcTs = tfMeta[tf].last_closed_ts;
    const lcCandle = lastClosedCandle(kl, lcTs);

    const closes = kl.map((k) => k.c);
    const ema20 = emaSeries(closes, 20);
    const ema50 = emaSeries(closes, 50);
    const ema200 = emaSeries(closes, 200);
    const rsi14 = rsiSeries(closes, 14);
    const atr14 = atrSeries(kl, 14);
    const adx14 = adxSeries(kl, 14);
    const bb = bb20_2(closes);

    const lastIdx = closes.length - 1;
    const lastEma20 = ema20[lastIdx];
    const lastEma50 = ema50[lastIdx];
    const lastEma200 = ema200[lastIdx];
    const lastRsi = rsi14[lastIdx];
    const lastAtr = atr14[lastIdx];
    const lastAdx = adx14[lastIdx];

    const lastClose = lcCandle?.c ?? closes[lastIdx] ?? null;

    indicators[tf] = {
      last_closed_candle: lcCandle,
      atr14: {
        value: Number.isFinite(lastAtr) ? lastAtr : null,
        pct: (Number.isFinite(lastAtr) && Number.isFinite(lastClose) && lastClose !== 0) ? (lastAtr / lastClose) * 100 : null,
      },
      ema: {
        "20": Number.isFinite(lastEma20) ? lastEma20 : null,
        "50": Number.isFinite(lastEma50) ? lastEma50 : null,
        "200": Number.isFinite(lastEma200) ? lastEma200 : null,
        slope: {
          "20": slopeOf(ema20, 5),
          "50": slopeOf(ema50, 5),
          "200": slopeOf(ema200, 5),
        }
      },
      rsi14: Number.isFinite(lastRsi) ? lastRsi : null,
      adx14: Number.isFinite(lastAdx) ? lastAdx : null,
      bb20_2: bb,
    };

    // Volume profile for execution TFs (15/60) + optional 240
    if (["15", "60", "240"].includes(tf)) {
      const vp = computeVolumeProfile(kl, 48);
      if (vp) {
        volume_profile[tf] = {
          poc: vp.poc,
          vah: vp.vah,
          val: vp.val,
          va_width: vp.va_width,
          bins: { step: vp.step, lo: vp.lo, hi: vp.hi },
        };
      }
    }

    const swings = computeSwings(kl);
    const reg = computeRegime({
      close: lastClose,
      ema20: indicators[tf].ema["20"],
      ema50: indicators[tf].ema["50"],
      ema200: indicators[tf].ema["200"],
      adx14: indicators[tf].adx14,
    });

    // Range box: last 40 bars high/low
    const N = 40;
    let rangeBox = null;
    if (kl.length >= N) {
      const slice = kl.slice(kl.length - N);
      const hi = Math.max(...slice.map((k) => k.h));
      const lo = Math.min(...slice.map((k) => k.l));
      const atr = indicators[tf].atr14.value;
      rangeBox = {
        hi,
        lo,
        width_atr: (Number.isFinite(atr) && atr > 0) ? (hi - lo) / atr : null
      };
    }

    price_structure[tf] = {
      regime: reg.regime,
      trend_label: reg.trend_label,
      strength: { score: reg.strength_score, reasons: reg.reasons },
      swings: {
        last_swing_high: swings.last_swing_high,
        last_swing_low: swings.last_swing_low,
        bos_level: swings.last_swing_high, // deterministic placeholder
        choch_level: swings.last_swing_low, // deterministic placeholder
      },
      range_box: rangeBox,
    };
  }

  // Key levels: previous day (from D candles if available)
  let previous_day = { high: null, low: null, close: null, mid: null };
  const d = norm["D"];
  if (d && d.length >= 3) {
    // last candle may be running, so "previous day" is last closed day
    const dMeta = tfMeta["D"];
    const lastClosed = lastClosedCandle(d, dMeta.last_closed_ts);
    // previous day = candle before lastClosed
    const idx = d.findIndex((k) => Number(k.t) === Number(lastClosed?.ts));
    if (idx > 0) {
      const prev = d[idx - 1];
      previous_day = {
        high: prev.h, low: prev.l, close: prev.c,
        mid: (prev.h + prev.l) / 2,
      };
    }
  }

  const guards = {
    min_rr: 1.5,
    acceptance: { min_close_beyond_atr: 0.1 },
    doji: { max_body_to_range: 0.25 },
    zone: { max_width_atr: 1.0, max_stop_distance_atr: 1.8 },
  };

  return {
    snapshot_version: "3.3-internal-full",
    symbol,
    asof_ts: nowTs,
    source: { venue: "bybit", market: "linear", environment: "prod" },
    raw_refs: {
      fetched_at_ts: raw?.fetched_at_ts ?? null,
      server_time_ts: raw?.server_time_ts ?? null,
      request_ids: raw?.request_ids ?? [],
    },
    data_quality: {
      grade: dq.grade,
      issues: dq.issues,
      time_alignment: {
        server_time_ts: raw?.server_time_ts ?? null,
        local_time_ts: nowTs,
        skew_ms: (raw?.server_time_ts != null) ? (nowTs - Number(raw.server_time_ts)) : null,
      }
    },
    market: raw?.market ?? {
      price: { last: null, mark: null, index: null, bid: null, ask: null, spread: null, spread_bps: null },
      ticker_24h: { high: null, low: null, volume: null, turnover: null, change_pct: null },
      derivatives: {
        funding: { rate: null, next_funding_ts: null, history: [] },
        open_interest: { value: null, history: [] },
        long_short_ratio: { account: { value: null, history: [] }, position: { value: null, history: [] } },
        liquidations: { history: [] },
      },
      microstructure: {
        orderbook: { ts: null, bids: [], asks: [], imbalance: null },
        recent_trades: { ts: null, buy_vol: null, sell_vol: null, delta: null },
      }
    },
    timeframes: Object.fromEntries(Object.entries(tfMeta).map(([k, v]) => [k, v])),
    indicators,
    volume_profile,
    key_levels: {
      previous_day,
      previous_week: { high: null, low: null, close: null, mid: null },
      pivots: { P: null, R1: null, S1: null, R2: null, S2: null },
    },
    price_structure,
    guards,
  };
}
