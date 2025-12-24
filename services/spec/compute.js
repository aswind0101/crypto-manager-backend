// crypto-manager-backend/services/spec/compute.js

function sma(values, period) {
  if (values.length < period) return null;
  let s = 0;
  for (let i = values.length - period; i < values.length; i++) s += values[i];
  return s / period;
}

export function emaSeries(closes, period) {
  if (!closes || closes.length === 0) return [];
  const k = 2 / (period + 1);
  const out = new Array(closes.length);
  // seed with SMA if possible; else first close
  const seed = closes.length >= period ? sma(closes.slice(0, period), period) : closes[0];
  out[0] = seed;
  for (let i = 1; i < closes.length; i++) out[i] = closes[i] * k + out[i - 1] * (1 - k);
  return out;
}

export function rsiSeries(closes, period = 14) {
  if (!closes || closes.length < period + 1) return [];
  const out = new Array(closes.length).fill(null);

  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const ch = closes[i] - closes[i - 1];
    if (ch >= 0) gain += ch; else loss -= ch;
  }
  gain /= period; loss /= period;

  out[period] = loss === 0 ? 100 : 100 - (100 / (1 + (gain / loss)));

  for (let i = period + 1; i < closes.length; i++) {
    const ch = closes[i] - closes[i - 1];
    const g = ch > 0 ? ch : 0;
    const l = ch < 0 ? -ch : 0;
    gain = (gain * (period - 1) + g) / period;
    loss = (loss * (period - 1) + l) / period;
    out[i] = loss === 0 ? 100 : 100 - (100 / (1 + (gain / loss)));
  }
  return out;
}

export function trueRangeSeries(klines) {
  if (!klines || klines.length < 2) return [];
  const out = new Array(klines.length).fill(null);
  for (let i = 1; i < klines.length; i++) {
    const h = klines[i].h, l = klines[i].l, pc = klines[i - 1].c;
    const tr = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
    out[i] = tr;
  }
  return out;
}

export function atrSeries(klines, period = 14) {
  const tr = trueRangeSeries(klines);
  if (tr.length < period + 1) return [];
  const out = new Array(klines.length).fill(null);

  // seed ATR with SMA of first period TRs (starting at index 1)
  let sum = 0;
  for (let i = 1; i <= period; i++) sum += tr[i];
  let atr = sum / period;
  out[period] = atr;

  for (let i = period + 1; i < klines.length; i++) {
    atr = ((atr * (period - 1)) + tr[i]) / period;
    out[i] = atr;
  }
  return out;
}

/**
 * ADX(14) deterministic, simplified but standard.
 */
export function adxSeries(klines, period = 14) {
  if (!klines || klines.length < period * 2) return [];
  const out = new Array(klines.length).fill(null);

  const plusDM = new Array(klines.length).fill(0);
  const minusDM = new Array(klines.length).fill(0);
  const tr = trueRangeSeries(klines);

  for (let i = 1; i < klines.length; i++) {
    const upMove = klines[i].h - klines[i - 1].h;
    const downMove = klines[i - 1].l - klines[i].l;
    plusDM[i] = (upMove > downMove && upMove > 0) ? upMove : 0;
    minusDM[i] = (downMove > upMove && downMove > 0) ? downMove : 0;
  }

  // Wilder smoothing
  let tr14 = 0, p14 = 0, m14 = 0;
  for (let i = 1; i <= period; i++) {
    tr14 += tr[i];
    p14 += plusDM[i];
    m14 += minusDM[i];
  }

  let plusDI = 100 * (p14 / tr14);
  let minusDI = 100 * (m14 / tr14);
  let dx = 100 * (Math.abs(plusDI - minusDI) / (plusDI + minusDI));
  // seed ADX with SMA of DX over next period
  let adxSum = 0;
  const dxArr = new Array(klines.length).fill(null);
  dxArr[period] = dx;

  for (let i = period + 1; i <= period * 2 && i < klines.length; i++) {
    tr14 = tr14 - (tr14 / period) + tr[i];
    p14 = p14 - (p14 / period) + plusDM[i];
    m14 = m14 - (m14 / period) + minusDM[i];
    plusDI = 100 * (p14 / tr14);
    minusDI = 100 * (m14 / tr14);
    dx = 100 * (Math.abs(plusDI - minusDI) / (plusDI + minusDI));
    dxArr[i] = dx;
    adxSum += dx;
  }

  const seedIndex = period * 2;
  if (seedIndex < klines.length) {
    let adx = adxSum / period;
    out[seedIndex] = adx;

    for (let i = seedIndex + 1; i < klines.length; i++) {
      tr14 = tr14 - (tr14 / period) + tr[i];
      p14 = p14 - (p14 / period) + plusDM[i];
      m14 = m14 - (m14 / period) + minusDM[i];
      plusDI = 100 * (p14 / tr14);
      minusDI = 100 * (m14 / tr14);
      dx = 100 * (Math.abs(plusDI - minusDI) / (plusDI + minusDI));
      adx = ((adx * (period - 1)) + dx) / period;
      out[i] = adx;
    }
  }

  return out;
}

export function bb20_2(closes) {
  const period = 20;
  if (!closes || closes.length < period) return { mid: null, upper: null, lower: null, width_pct: null };
  const slice = closes.slice(closes.length - period);
  const mid = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((a, b) => a + (b - mid) ** 2, 0) / period;
  const sd = Math.sqrt(variance);
  const upper = mid + 2 * sd;
  const lower = mid - 2 * sd;
  const widthPct = mid !== 0 ? ((upper - lower) / mid) * 100 : null;
  return { mid, upper, lower, width_pct: widthPct };
}

/**
 * Deterministic swing points (fractal 2-left / 2-right).
 */
export function computeSwings(klines) {
  if (!klines || klines.length < 5) return { last_swing_high: null, last_swing_low: null };
  let lastHigh = null;
  let lastLow = null;

  for (let i = 2; i < klines.length - 2; i++) {
    const h = klines[i].h;
    const l = klines[i].l;

    const isSwingHigh =
      h > klines[i - 1].h && h > klines[i - 2].h &&
      h >= klines[i + 1].h && h >= klines[i + 2].h;

    const isSwingLow =
      l < klines[i - 1].l && l < klines[i - 2].l &&
      l <= klines[i + 1].l && l <= klines[i + 2].l;

    if (isSwingHigh) lastHigh = h;
    if (isSwingLow) lastLow = l;
  }
  return { last_swing_high: lastHigh, last_swing_low: lastLow };
}

/**
 * Regime/trend label using EMA stack + ADX thresholds (deterministic).
 */
export function computeRegime({ close, ema20, ema50, ema200, adx14 }) {
  if ([close, ema20, ema50, ema200].some((x) => x == null || !Number.isFinite(x))) {
    return { regime: "transition", trend_label: "range", strength_score: 0, reasons: ["missing_ema"] };
  }
  const reasons = [];
  let score = 0;

  const bullStack = close > ema20 && ema20 > ema50 && ema50 > ema200;
  const bearStack = close < ema20 && ema20 < ema50 && ema50 < ema200;

  if (bullStack) { score += 50; reasons.push("ema_stack_bull"); }
  if (bearStack) { score += 50; reasons.push("ema_stack_bear"); }

  const adx = Number.isFinite(adx14) ? adx14 : 0;
  if (adx >= 25) { score += 25; reasons.push("adx_trend"); }
  if (adx < 18) { reasons.push("adx_weak"); }

  let trend_label = "range";
  if (bullStack) trend_label = "bull";
  else if (bearStack) trend_label = "bear";

  let regime = "transition";
  if (adx >= 25 && (bullStack || bearStack)) regime = "trend";
  else if (adx < 18) regime = "range";

  return { regime, trend_label, strength_score: Math.min(100, score), reasons };
}

/**
 * Very simple volume profile on closes with fixed bins.
 * Deterministic, fast, good enough for VAH/VAL/POC anchors.
 */
export function computeVolumeProfile(klines, binCount = 48) {
  if (!klines || klines.length < 50) return null;
  const closes = klines.map((k) => k.c);
  const lo = Math.min(...closes);
  const hi = Math.max(...closes);
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) return null;

  const step = (hi - lo) / binCount;
  const bins = new Array(binCount).fill(0);

  for (let i = 0; i < klines.length; i++) {
    const p = closes[i];
    const v = Number(klines[i].v ?? 0);
    let idx = Math.floor((p - lo) / step);
    if (idx < 0) idx = 0;
    if (idx >= binCount) idx = binCount - 1;
    bins[idx] += v;
  }

  // POC = max bin center
  let pocIdx = 0;
  for (let i = 1; i < binCount; i++) if (bins[i] > bins[pocIdx]) pocIdx = i;
  const poc = lo + (pocIdx + 0.5) * step;

  // Value Area 70% around POC
  const total = bins.reduce((a, b) => a + b, 0);
  const target = total * 0.7;

  let left = pocIdx, right = pocIdx;
  let acc = bins[pocIdx];

  while (acc < target && (left > 0 || right < binCount - 1)) {
    const leftNext = left > 0 ? bins[left - 1] : -1;
    const rightNext = right < binCount - 1 ? bins[right + 1] : -1;
    if (rightNext >= leftNext) { right++; acc += bins[right]; }
    else { left--; acc += bins[left]; }
  }

  const val = lo + left * step;
  const vah = lo + (right + 1) * step;
  const vaWidth = vah - val;

  return { lo, hi, step, poc, val, vah, va_width: vaWidth };
}
