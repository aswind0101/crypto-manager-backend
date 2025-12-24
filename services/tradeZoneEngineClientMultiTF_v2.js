// crypto-manager-backend/services/tradeZoneEngineClientMultiTF_v2.js
import crypto from "crypto";

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

/** ---------- Indicators ---------- */
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

/** ---------- Volume Profile (stable) ---------- */
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
    if (ema20 != null && ema50 != null && ema100 != null && ema200 != null && ema20 > ema50 && ema50 > ema100 && ema100 > ema200)
        return "bull";
    if (ema20 != null && ema50 != null && ema100 != null && ema200 != null && ema20 < ema50 && ema50 < ema100 && ema100 < ema200)
        return "bear";
    return "mixed";
}
function trendState({ close, ema20, ema50, rsi, atr }) {
    if (close != null && ema20 != null && ema50 != null && rsi != null && atr != null) {
        const nearEma20 = Math.abs(close - ema20) < 0.5 * atr;

        // Đo "độ tách" giữa EMA20 và EMA50 để phân biệt trend vs range
        const emaSep = Math.abs(ema20 - ema50);
        const tightMAs = emaSep < 0.25 * atr; // MA dính nhau => dễ range

        // Trend (giữ nguyên yêu cầu cấu trúc giá/EMA)
        if (close > ema20 && ema20 > ema50 && rsi >= 55) return "bull";

        // Nới nhẹ bear RSI để tránh kẹt "range" khi EMA đã bear rõ
        // (Nếu bạn muốn giữ cực strict thì đổi 50 -> 45)
        if (close < ema20 && ema20 < ema50 && rsi <= 50) return "bear";

        // Range chỉ khi: giá quanh EMA20 + RSI trung tính + MA dính nhau
        if (nearEma20 && rsi >= 45 && rsi <= 55 && tightMAs) return "range";
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

/** ---------- Swing anchors (SPEC-aligned enough for breakout/retest) ---------- */
function swingAnchors(klines, lookback = 80) {
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

/** ---------- Context resolver ---------- */
function resolveContext(htfRegime, ltfRegime) {
    if ((htfRegime === "bull" && ltfRegime === "bull") || (htfRegime === "bear" && ltfRegime === "bear")) return "trend";
    if (htfRegime === "bull" && (ltfRegime === "bear" || ltfRegime === "neutral")) return "pullback";
    if (htfRegime === "bear" && (ltfRegime === "bull" || ltfRegime === "neutral")) return "pullback";
    if (htfRegime === "range") return "range";
    return "range";
}

/** ---------- Feature builder per TF ---------- */
function buildTFState(klines, { vpLookback = 240 } = {}) {
    const closes = klines.map((k) => k.c);
    const ema20 = emaSeries(closes, 20);
    const ema50 = emaSeries(closes, 50);
    const ema100 = emaSeries(closes, 100);
    const ema200 = emaSeries(closes, 200);
    const rsi = rsiSeries(closes, 14);
    const atr = atrSeries(klines, 14);

    const last = klines.length - 1;
    const close = closes[last];
    const state = {
        close,
        ema20: ema20[last],
        ema50: ema50[last],
        ema100: ema100[last],
        ema200: ema200[last],
        rsi: rsi[last],
        atr: atr[last],
    };

    state.emaStack = emaStackLabel(state.ema20, state.ema50, state.ema100, state.ema200);
    state.vp = volumeProfile(klines.slice(-vpLookback), 60);
    state.swing = swingAnchors(klines, 80);
    state.regime = trendState({ close: state.close, ema20: state.ema20, ema50: state.ema50, rsi: state.rsi, atr: state.atr });
    state.volReg = volatilityRegime(state.atr, state.close);
    return state;
}

/** ---------- Common scoring adjustments (Balanced + SPEC) ---------- */
function applyM5Timing({ confidence, guards, direction, m5Regime }) {
    // SPEC-style: M5 is timing, not context. It can veto/guard but not flip HTF.
    if (direction === "short") {
        if (m5Regime === "bear") confidence += 6;
        if (m5Regime === "bull") {
            confidence -= 10;
            guards.push("m5_against_direction_wait_confirm");
        }
    } else {
        if (m5Regime === "bull") confidence += 6;
        if (m5Regime === "bear") {
            confidence -= 10;
            guards.push("m5_against_direction_wait_confirm");
        }
    }
    return { confidence, guards };
}
/** ---------- Order readiness helpers (SPEC-aligned) ---------- */
function mid(low, high) {
    return (low + high) / 2;
}

function evalIntoZone(close, zone) {
    return Number.isFinite(close) && Number.isFinite(zone?.low) && Number.isFinite(zone?.high)
        ? close >= zone.low && close <= zone.high
        : false;
}

/**
 * Retest triggers (Balanced):
 *  - SHORT: close < EMA20 AND close < VAH
 *  - LONG : close > EMA20 AND close > VAL
 */
function evalRetestTriggers({ direction, close, zone, ema20, vp }) {
    const into = evalIntoZone(close, zone);

    let closeConfirm = false;
    if (direction === "short") {
        closeConfirm =
            Number.isFinite(close) &&
            Number.isFinite(ema20) &&
            vp?.vah != null &&
            close < ema20 &&
            close < vp.vah;
    } else {
        closeConfirm =
            Number.isFinite(close) &&
            Number.isFinite(ema20) &&
            vp?.val != null &&
            close > ema20 &&
            close > vp.val;
    }

    const status = into && closeConfirm ? "triggered" : "pending";
    return { into, closeConfirm, status };
}

/**
 * Trend-continuation triggers (Balanced):
 *  - SHORT: close < EMA20 AND close < POC
 *  - LONG : close > EMA20 AND close > POC
 */
function evalFadeTriggers({ direction, close, zone, ema20, vp }) {
    const into = evalIntoZone(close, zone);

    let closeConfirm = false;
    if (direction === "short") {
        closeConfirm =
            Number.isFinite(close) &&
            Number.isFinite(ema20) &&
            vp?.poc != null &&
            close < ema20 &&
            close < vp.poc;
    } else {
        closeConfirm =
            Number.isFinite(close) &&
            Number.isFinite(ema20) &&
            vp?.poc != null &&
            close > ema20 &&
            close > vp.poc;
    }

    const status = into && closeConfirm ? "triggered" : "pending";
    return { into, closeConfirm, status };
}

/**
 * Entry plan (deterministic):
 * - pending + outside zone  => LIMIT at zone mid
 * - pending + inside zone   => WAIT for close_confirm
 * - triggered               => MARKET now
 */
function buildEntryPlan({ close, zone, status, into, closeConfirm }) {
    const entryMid = mid(zone.low, zone.high);

    if (status === "triggered") {
        return {
            entry_now: true,
            order_type: "market",
            suggested_entry: close,
            note: "Đã vào zone và có close_confirm (Balanced). Có thể vào Market theo close hiện tại.",
        };
    }

    if (!into) {
        return {
            entry_now: false,
            order_type: "limit",
            suggested_entry: entryMid,
            note: "Chưa chạm zone. Đặt Limit tại giữa zone và chờ price_into_zone + close_confirm.",
        };
    }

    // price in zone but not confirmed
    return {
        entry_now: false,
        order_type: "wait",
        suggested_entry: null,
        note: closeConfirm
            ? "Đã có close_confirm nhưng giá không nằm trong zone (hiếm). Kiểm tra dữ liệu nến."
            : "Giá đã vào zone nhưng chưa có close_confirm. Chờ nến đóng xác nhận.",
    };
}

/**
 * Entry validity: valid until expiresAt AND price not too far from zone (> kFar*ATR).
 */
function buildEntryValidity({ close, atr, zone, expiresAt, kFar = 2.0 }) {
    let far = "ok";
    if (Number.isFinite(close) && Number.isFinite(atr)) {
        if (close > zone.high + kFar * atr) far = "above_far";
        else if (close < zone.low - kFar * atr) far = "below_far";
    }

    return {
        valid_until: expiresAt ?? null,
        far_state: far, // ok | above_far | below_far
        is_valid: far === "ok",
    };
}

/** ---------- Zone builders (SPEC style) ---------- */
function buildRetestSupplyDemand({
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
    volReg,
    emaStack,
}) {
    // Priority zone type when context=trend: retest of VAH/VAL & EMA50 band
    const zones = [];
    if (!vp || !Number.isFinite(atr) || !Number.isFinite(close)) return zones;

    const rrMin = 1.5;
    const buffer = 0.35 * atr; // SPEC-like band around level
    const guards = ["data_stale"];
    if (volReg === "high") guards.push("volatility_high");

    if (direction === "short") {
        // supply zone centered near max(VAH, EMA50) in downtrend
        const ema50Dist = Number.isFinite(ema50) ? Math.abs(ema50 - vp.vah) : null;
        const ema50DistAtr = ema50Dist != null && Number.isFinite(atr) ? ema50Dist / atr : null;
        const ema50AnchorUsed = ema50DistAtr != null ? ema50DistAtr <= 1.5 : false; // guard: EMA50 gần VAH trong 1.5 ATR
        const center = ema50AnchorUsed ? Math.max(vp.vah, ema50) : vp.vah;

        const low = center - buffer;
        const high = center + buffer;

        const stop = (Number.isFinite(swing?.lastHigh) ? Math.max(swing.lastHigh, high) : high) + 0.25 * atr;
        const entryRef = clamp(close, low, high);

        const t1 = vp.poc; // fair value
        const t2 = Number.isFinite(swing?.lastLow) ? swing.lastLow : vp.val;

        const rr1 = rrForShort(entryRef, stop, t1);
        const rr2 = rrForShort(entryRef, stop, t2);
        if (!((rr1 != null && rr1 >= rrMin) || (rr2 != null && rr2 >= rrMin))) return zones;

        let confidence =
            68 + // base higher because this is preferred SPEC zone
            (emaStack === "bear" ? 10 : emaStack === "mixed" ? 4 : 0) +
            (volReg === "high" ? -10 : 0);

        ({ confidence } = applyM5Timing({ confidence, guards, direction: "short", m5Regime }));
        const trig = evalRetestTriggers({ direction: "short", close, zone: { low, high }, ema20, vp });
        const entry = buildEntryPlan({ close, zone: { low, high }, status: trig.status, into: trig.into, closeConfirm: trig.closeConfirm });
        const entry_validity = buildEntryValidity({
            close,
            atr,
            zone: { low, high },
            expiresAt: Date.now() + 2 * 60 * 60 * 1000,
        });

        zones.push({
            id: hashId(`${symbol}:${tfLabel}:retest_short:${low.toFixed(2)}:${high.toFixed(2)}`),
            symbol,
            tf: tfLabel,
            direction: "short",
            type: "retest_entry",
            status: trig.status,
            entry,
            entry_validity,
            zone: { low, high },
            triggers: [
                { type: "price_into_zone", rule: "Price retests supply band (VAH/EMA50)" },
                { type: "close_confirm", rule: "Close rejects zone (Balanced confirm: close back below EMA20 / below VAH)" },
            ],
            invalidation: {
                type: "hard_stop",
                level: stop,
                rule: "Stop above supply band / swing high buffer",
            },
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
                    `SPEC priority: Retest supply in trend context (HTF ${htfRegime}, LTF ${ltfRegime})`,
                    `Anchors: VAH=${vp.vah.toFixed(2)}, EMA50=${ema50?.toFixed?.(2) ?? "n/a"}, POC=${vp.poc.toFixed(2)}`,
                    `Balanced triggers: touch + close rejection`,
                ],
                facts: {
                    close,
                    atr,
                    ema20: ema20 ?? null,
                    ema50: ema50 ?? null,
                    ema50AnchorUsed,
                    ema50DistAtr,
                    val: vp.val,
                    poc: vp.poc,
                    vah: vp.vah,
                    htfRegime,
                    ltfRegime,
                    m5Regime,
                    emaStack,
                },
            },
            guards: { noTradeIf: guards, expiresAt: Date.now() + 2 * 60 * 60 * 1000 },
        });
    } else {
        // demand zone centered near min(VAL, EMA50) in uptrend
        const ema50Dist = Number.isFinite(ema50) ? Math.abs(ema50 - vp.val) : null;
        const ema50DistAtr = ema50Dist != null && Number.isFinite(atr) ? ema50Dist / atr : null;
        const ema50AnchorUsed = ema50DistAtr != null ? ema50DistAtr <= 1.5 : false; // guard: EMA50 gần VAL trong 1.5 ATR
        const center = ema50AnchorUsed ? Math.min(vp.val, ema50) : vp.val;

        const low = center - buffer;
        const high = center + buffer;

        const stop = (Number.isFinite(swing?.lastLow) ? Math.min(swing.lastLow, low) : low) - 0.25 * atr;
        const entryRef = clamp(close, low, high);

        const t1 = vp.poc;
        const t2 = Number.isFinite(swing?.lastHigh) ? swing.lastHigh : vp.vah;

        const rr1 = rrForLong(entryRef, stop, t1);
        const rr2 = rrForLong(entryRef, stop, t2);
        if (!((rr1 != null && rr1 >= rrMin) || (rr2 != null && rr2 >= rrMin))) return zones;

        let confidence =
            68 +
            (emaStack === "bull" ? 10 : emaStack === "mixed" ? 4 : 0) +
            (volReg === "high" ? -10 : 0);

        ({ confidence } = applyM5Timing({ confidence, guards, direction: "long", m5Regime }));
        const trig = evalRetestTriggers({ direction: "long", close, zone: { low, high }, ema20, vp });
        const entry = buildEntryPlan({ close, zone: { low, high }, status: trig.status, into: trig.into, closeConfirm: trig.closeConfirm });
        const entry_validity = buildEntryValidity({
            close,
            atr,
            zone: { low, high },
            expiresAt: Date.now() + 2 * 60 * 60 * 1000,
        });

        zones.push({
            id: hashId(`${symbol}:${tfLabel}:retest_long:${low.toFixed(2)}:${high.toFixed(2)}`),
            symbol,
            tf: tfLabel,
            direction: "long",
            type: "retest_entry",
            status: trig.status,
            entry,
            entry_validity,
            zone: { low, high },
            triggers: [
                { type: "price_into_zone", rule: "Price retests demand band (VAL/EMA50)" },
                { type: "close_confirm", rule: "Close rejects zone upward (Balanced confirm: close back above EMA20 / above VAL)" },
            ],
            invalidation: {
                type: "hard_stop",
                level: stop,
                rule: "Stop below demand band / swing low buffer",
            },
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
                    `SPEC priority: Retest demand in trend context (HTF ${htfRegime}, LTF ${ltfRegime})`,
                    `Anchors: VAL=${vp.val.toFixed(2)}, EMA50=${ema50?.toFixed?.(2) ?? "n/a"}, POC=${vp.poc.toFixed(2)}`,
                    `Balanced triggers: touch + close rejection`,
                ],
                facts: {
                    close,
                    atr,
                    ema20: ema20 ?? null,
                    ema50: ema50 ?? null,
                    ema50AnchorUsed,
                    ema50DistAtr,
                    val: vp.val,
                    poc: vp.poc,
                    vah: vp.vah,
                    htfRegime,
                    ltfRegime,
                    m5Regime,
                    emaStack,
                },
            },
            guards: { noTradeIf: guards, expiresAt: Date.now() + 2 * 60 * 60 * 1000 },
        });
    }

    return zones;
}

function buildFadePOCorEMA20({
    symbol,
    tfLabel,
    direction,
    close,
    atr,
    vp,
    ema20,
    swing,
    htfRegime,
    ltfRegime,
    m5Regime,
    volReg,
    emaStack,
}) {
    // Secondary in trend context: fade toward POC/EMA20 (spec: fair value pullback)
    const zones = [];
    if (!vp || !Number.isFinite(atr) || !Number.isFinite(close)) return zones;

    const rrMin = 1.5;
    const k = volReg === "low" ? 0.45 : volReg === "high" ? 0.75 : 0.55;
    const width = k * atr;

    const guards = ["data_stale"];
    if (volReg === "high") guards.push("volatility_high");

    if (direction === "short") {
        // center near min(POC, EMA20?) for a short re-entry after minor bounce
        const center = Math.max(vp.poc, ema20 ?? vp.poc);
        const low = center - width;
        const high = center + width;

        const stop = (Number.isFinite(swing?.lastHigh) ? Math.max(swing.lastHigh, high) : high) + 0.25 * atr;
        const entryRef = clamp(close, low, high);

        const t1 = vp.val;
        const t2 = Number.isFinite(swing?.lastLow) ? swing.lastLow : vp.val;

        const rr1 = rrForShort(entryRef, stop, t1);
        const rr2 = rrForShort(entryRef, stop, t2);
        if (!((rr1 != null && rr1 >= rrMin) || (rr2 != null && rr2 >= rrMin))) return zones;

        let confidence =
            58 +
            (emaStack === "bear" ? 8 : emaStack === "mixed" ? 3 : 0) +
            (volReg === "high" ? -10 : 0);

        ({ confidence } = applyM5Timing({ confidence, guards, direction: "short", m5Regime }));
        const trig = evalFadeTriggers({ direction: "short", close, zone: { low, high }, ema20, vp });
        const entry = buildEntryPlan({ close, zone: { low, high }, status: trig.status, into: trig.into, closeConfirm: trig.closeConfirm });
        const entry_validity = buildEntryValidity({
            close,
            atr,
            zone: { low, high },
            expiresAt: Date.now() + 90 * 60 * 1000,
        });

        zones.push({
            id: hashId(`${symbol}:${tfLabel}:fade_short:${low.toFixed(2)}:${high.toFixed(2)}`),
            symbol,
            tf: tfLabel,
            direction: "short",
            type: "trend_continuation",
            status: trig.status,
            entry,
            entry_validity,
            zone: { low, high },
            triggers: [
                { type: "price_into_zone", rule: "Price pulls back into fair value band (POC/EMA20)" },
                { type: "close_confirm", rule: "Close confirms rejection (Balanced: close back below EMA20/POC)" },
            ],
            invalidation: { type: "hard_stop", level: stop, rule: "Stop above band / swing high buffer" },
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
                    `SPEC secondary: Fade toward POC/EMA20 in trend context (HTF ${htfRegime}, LTF ${ltfRegime})`,
                    `Anchors: POC=${vp.poc.toFixed(2)}, EMA20=${ema20?.toFixed?.(2) ?? "n/a"}, VAL=${vp.val.toFixed(2)}`,
                    `Balanced triggers: touch + close confirm`,
                ],
                facts: { close, atr, poc: vp.poc, val: vp.val, vah: vp.vah, ema20: ema20 ?? null, htfRegime, ltfRegime, m5Regime, emaStack },
            },
            guards: { noTradeIf: guards, expiresAt: Date.now() + 90 * 60 * 1000 },
        });
    } else {
        const center = Math.min(vp.poc, ema20 ?? vp.poc);
        const low = center - width;
        const high = center + width;

        const stop = (Number.isFinite(swing?.lastLow) ? Math.min(swing.lastLow, low) : low) - 0.25 * atr;
        const entryRef = clamp(close, low, high);

        const t1 = vp.vah;
        const t2 = Number.isFinite(swing?.lastHigh) ? swing.lastHigh : vp.vah;

        const rr1 = rrForLong(entryRef, stop, t1);
        const rr2 = rrForLong(entryRef, stop, t2);
        if (!((rr1 != null && rr1 >= rrMin) || (rr2 != null && rr2 >= rrMin))) return zones;

        let confidence =
            58 +
            (emaStack === "bull" ? 8 : emaStack === "mixed" ? 3 : 0) +
            (volReg === "high" ? -10 : 0);

        ({ confidence } = applyM5Timing({ confidence, guards, direction: "long", m5Regime }));
        const trig = evalFadeTriggers({ direction: "long", close, zone: { low, high }, ema20, vp });
        const entry = buildEntryPlan({ close, zone: { low, high }, status: trig.status, into: trig.into, closeConfirm: trig.closeConfirm });
        const entry_validity = buildEntryValidity({
            close,
            atr,
            zone: { low, high },
            expiresAt: Date.now() + 90 * 60 * 1000,
        });

        zones.push({
            id: hashId(`${symbol}:${tfLabel}:fade_long:${low.toFixed(2)}:${high.toFixed(2)}`),
            symbol,
            tf: tfLabel,
            direction: "long",
            type: "trend_continuation",
            status: trig.status,
            entry,
            entry_validity,
            zone: { low, high },
            triggers: [
                { type: "price_into_zone", rule: "Price pulls back into fair value band (POC/EMA20)" },
                { type: "close_confirm", rule: "Close confirms rejection upward (Balanced: close back above EMA20/POC)" },
            ],
            invalidation: { type: "hard_stop", level: stop, rule: "Stop below band / swing low buffer" },
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
                    `SPEC secondary: Fade toward POC/EMA20 in trend context (HTF ${htfRegime}, LTF ${ltfRegime})`,
                    `Anchors: POC=${vp.poc.toFixed(2)}, EMA20=${ema20?.toFixed?.(2) ?? "n/a"}, VAH=${vp.vah.toFixed(2)}`,
                    `Balanced triggers: touch + close confirm`,
                ],
                facts: { close, atr, poc: vp.poc, val: vp.val, vah: vp.vah, ema20: ema20 ?? null, htfRegime, ltfRegime, m5Regime, emaStack },
            },
            guards: { noTradeIf: guards, expiresAt: Date.now() + 90 * 60 * 1000 },
        });
    }

    return zones;
}

function buildBreakoutEntry({
    symbol,
    tfLabel,
    direction,
    close,
    atr,
    swing,
    htfRegime,
    ltfRegime,
    m5Regime,
    volReg,
    emaStack,
}) {
    // SPEC: breakout needs close_confirm; here we model as "potential breakout band"
    const zones = [];
    if (!Number.isFinite(close) || !Number.isFinite(atr) || !swing) return zones;

    const rrMin = 1.5;
    const buffer = 0.25 * atr;
    const guards = ["data_stale"];
    if (volReg === "high") guards.push("volatility_high");

    if (direction === "short") {
        const level = swing.lastLow;
        // breakout band just below level
        const low = level - 0.6 * atr;
        const high = level + buffer;

        // invalidation: close back above level + buffer (modeled as stop above band)
        const stop = high + 0.4 * atr;
        const entryRef = clamp(close, low, high);
        // --- SPEC/Balanced actionability filter + status ---
        // Only emit breakout zone if price is already near the breakout band,
        // or the breakout is already triggered.
        // This prevents showing breakout zones when price is far above the level.
        const triggered = close <= (level - buffer);         // breakout confirmed
        const near = close <= (high + 0.25 * atr);           // within ~0.25 ATR of band
        if (!near && !triggered) return [];                  // not actionable now

        const status = triggered ? "triggered" : "pending";


        // targets: extension (ATR-based)
        const t1 = level - 1.0 * atr;
        const t2 = level - 2.0 * atr;

        const rr1 = rrForShort(entryRef, stop, t1);
        const rr2 = rrForShort(entryRef, stop, t2);
        if (!((rr1 != null && rr1 >= rrMin) || (rr2 != null && rr2 >= rrMin))) return zones;

        let confidence = 50 + (emaStack === "bear" ? 6 : 0) + (volReg === "high" ? -10 : 0);
        ({ confidence } = applyM5Timing({ confidence, guards, direction: "short", m5Regime }));

        zones.push({
            id: hashId(`${symbol}:${tfLabel}:breakout_short:${low.toFixed(2)}:${high.toFixed(2)}`),
            symbol,
            tf: tfLabel,
            direction: "short",
            type: "breakout_entry",
            status,
            zone: { low, high },
            triggers: [
                { type: "close_confirm", rule: "Close breaks and holds below swing low + buffer (Balanced confirm)" },
                { type: "volume_confirm", rule: "Optional: volume expansion on break (if available)" },
            ],
            invalidation: { type: "close_beyond", level: level + buffer, rule: "Invalidate if close reclaims broken level" },
            targets: [
                { level: t1, label: "T1", basis: "atr" },
                { level: t2, label: "T2", basis: "atr" },
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
                    `SPEC: Breakout in trend context (HTF ${htfRegime}, LTF ${ltfRegime})`,
                    `Break level=swingLow ${level.toFixed(2)} with buffer ${buffer.toFixed(2)}`,
                    `Balanced requires close confirmation`,
                ],
                facts: { close, atr, swingLow: level, buffer, htfRegime, ltfRegime, m5Regime, emaStack },
            },
            guards: { noTradeIf: guards, expiresAt: Date.now() + 60 * 60 * 1000 },
        });
    } else {
        const level = swing.lastHigh;
        const low = level - buffer;
        const high = level + 0.6 * atr;

        const stop = low - 0.4 * atr;
        const entryRef = clamp(close, low, high);
        // --- SPEC/Balanced actionability filter + status ---
        const triggered = close >= (level + buffer);         // breakout confirmed
        const near = close >= (low - 0.25 * atr);            // within ~0.25 ATR of band
        if (!near && !triggered) return [];                  // not actionable now

        const status = triggered ? "triggered" : "pending";


        const t1 = level + 1.0 * atr;
        const t2 = level + 2.0 * atr;

        const rr1 = rrForLong(entryRef, stop, t1);
        const rr2 = rrForLong(entryRef, stop, t2);
        if (!((rr1 != null && rr1 >= rrMin) || (rr2 != null && rr2 >= rrMin))) return zones;

        let confidence = 50 + (emaStack === "bull" ? 6 : 0) + (volReg === "high" ? -10 : 0);
        ({ confidence } = applyM5Timing({ confidence, guards, direction: "long", m5Regime }));

        zones.push({
            id: hashId(`${symbol}:${tfLabel}:breakout_long:${low.toFixed(2)}:${high.toFixed(2)}`),
            symbol,
            tf: tfLabel,
            direction: "long",
            type: "breakout_entry",
            status,
            zone: { low, high },
            triggers: [
                { type: "close_confirm", rule: "Close breaks and holds above swing high + buffer (Balanced confirm)" },
                { type: "volume_confirm", rule: "Optional: volume expansion on break (if available)" },
            ],
            invalidation: { type: "close_beyond", level: level - buffer, rule: "Invalidate if close loses broken level" },
            targets: [
                { level: t1, label: "T1", basis: "atr" },
                { level: t2, label: "T2", basis: "atr" },
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
                    `SPEC: Breakout in trend context (HTF ${htfRegime}, LTF ${ltfRegime})`,
                    `Break level=swingHigh ${level.toFixed(2)} with buffer ${buffer.toFixed(2)}`,
                    `Balanced requires close confirmation`,
                ],
                facts: { close, atr, swingHigh: level, buffer, htfRegime, ltfRegime, m5Regime, emaStack },
            },
            guards: { noTradeIf: guards, expiresAt: Date.now() + 60 * 60 * 1000 },
        });
    }

    return zones;
}

/** ---------- Public API ---------- */
export function generateTradeZonesMultiTFFromClientData_v2({
    symbol = "ETHUSDT",
    klinesByTF = {},
    receivedAt = Date.now(),
}) {
    const generatedAt = Date.now();

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
    if (D1.length > 0 && D1.length < min.D1) warnings.push("insufficient_klines_D1");

    if (H4.length < min.H4 || (H1.length < min.H1 && M15.length < min.M15) || M5.length < min.M5) {
        return { meta: { symbol, venue: "bybit", generatedAt, receivedAt, warnings }, tradeZones: [], report: null };
    }

    const stM5 = buildTFState(M5, { vpLookback: 260 });
    const stM15 = buildTFState(M15, { vpLookback: 240 });
    const stH1 = buildTFState(H1, { vpLookback: 220 });
    const stH4 = buildTFState(H4, { vpLookback: 220 });
    const stD1 = D1.length >= min.D1 ? buildTFState(D1, { vpLookback: 180 }) : null;

    const htf = stD1 ? { tf: "D1", state: stD1 } : { tf: "H4", state: stH4 };
    const htfRegime = htf.state.regime;

    const ctxH1 = resolveContext(htfRegime, stH1.regime);
    const ctxM15 = resolveContext(htfRegime, stM15.regime);

    const zones = [];

    // Execution TF loop: H1 and M15
    const execList = [
        { tf: "H1", st: stH1, ctx: ctxH1 },
        { tf: "M15", st: stM15, ctx: ctxM15 },
    ];

    for (const exec of execList) {
        const tfLabel = exec.tf;
        const st = exec.st;
        const ctx = exec.ctx;

        if (!st.vp || !Number.isFinite(st.atr) || !Number.isFinite(st.close)) continue;

        // Determine direction preference by HTF regime (SPEC: follow HTF)
        const dir = htfRegime === "bear" ? "short" : htfRegime === "bull" ? "long" : null;

        if (ctx === "trend" && dir) {
            // SPEC ranking preference:
            // 1) Retest supply/demand (VAH/VAL + EMA50 band)  [primary]
            zones.push(
                ...buildRetestSupplyDemand({
                    symbol,
                    tfLabel,
                    direction: dir,
                    close: st.close,
                    atr: st.atr,
                    vp: st.vp,
                    ema20: st.ema20,
                    ema50: st.ema50,
                    swing: st.swing,
                    htfRegime,
                    ltfRegime: st.regime,
                    m5Regime: stM5.regime,
                    volReg: st.volReg,
                    emaStack: st.emaStack,
                })
            );

            // 2) Fade POC/EMA20 (fair value pullback)         [secondary]
            zones.push(
                ...buildFadePOCorEMA20({
                    symbol,
                    tfLabel,
                    direction: dir,
                    close: st.close,
                    atr: st.atr,
                    vp: st.vp,
                    ema20: st.ema20,
                    swing: st.swing,
                    htfRegime,
                    ltfRegime: st.regime,
                    m5Regime: stM5.regime,
                    volReg: st.volReg,
                    emaStack: st.emaStack,
                })
            );

            // 3) Breakout (optional)                          [tertiary]
            zones.push(
                ...buildBreakoutEntry({
                    symbol,
                    tfLabel,
                    direction: dir,
                    close: st.close,
                    atr: st.atr,
                    swing: st.swing,
                    htfRegime,
                    ltfRegime: st.regime,
                    m5Regime: stM5.regime,
                    volReg: st.volReg,
                    emaStack: st.emaStack,
                })
            );
        }

        // (V2 vẫn giữ pullback/range behavior nếu bạn cần sau này; không remove.)
        // Ở đây mình không thêm để tránh vượt scope; focus SPEC-trend zones theo yêu cầu.
    }

    // SPEC ranking: type priority then confidence then risk
    const typePriority = (z) => {
        // higher is better
        if (z.type === "retest_entry") return 30;
        if (z.type === "trend_continuation") return 20;
        if (z.type === "breakout_entry") return 10;
        return 0;
    };

    zones.sort((a, b) => {
        const pa = typePriority(a);
        const pb = typePriority(b);
        if (pb !== pa) return pb - pa;
        if (b.confidence !== a.confidence) return b.confidence - a.confidence;
        return tierScore(a.risk.tier) - tierScore(b.risk.tier);
    });

    const tradeZones = zones.slice(0, 9);

    const report = {
        htf: { tf: htf.tf, regime: htfRegime, rsi: htf.state.rsi, emaStack: htf.state.emaStack },
        contexts: { H1: ctxH1, M15: ctxM15 },
        tf: {
            M5: { regime: stM5.regime, rsi: stM5.rsi, emaStack: stM5.emaStack },
            M15: { regime: stM15.regime, rsi: stM15.rsi, emaStack: stM15.emaStack, vp: stM15.vp },
            H1: { regime: stH1.regime, rsi: stH1.rsi, emaStack: stH1.emaStack, vp: stH1.vp },
            H4: { regime: stH4.regime, rsi: stH4.rsi, emaStack: stH4.emaStack },
            D1: stD1 ? { regime: stD1.regime, rsi: stD1.rsi, emaStack: stD1.emaStack } : null,
        },
    };

    return {
        meta: { symbol, venue: "bybit", generatedAt, receivedAt, warnings },
        report,
        tradeZones,
    };
}
