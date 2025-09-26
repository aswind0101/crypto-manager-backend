// backend/services/analyzer.js
import { q } from "../utils/db.js";
import dayjs from "dayjs";
import {
    RSI, EMA, MACD
} from "technicalindicators";

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
function normalize01(v, vmin, vmax) {
    if (vmin === vmax) return 0.5;
    return clamp((v - vmin) / (vmax - vmin), 0, 1);
}

// === ATR(14) helpers ===
async function getOhlcRows(coin_id, timeframe = "1h", limit = 120) {
    const { rows } = await q(
        `SELECT close_time, high, low, close
       FROM price_ohlc
      WHERE coin_id=$1 AND timeframe=$2
      ORDER BY close_time DESC
      LIMIT $3`,
        [coin_id, timeframe, limit]
    );
    // đảo ngược để tính từ cũ → mới
    return rows.reverse().map(r => ({
        t: new Date(r.close_time),
        high: Number(r.high),
        low: Number(r.low),
        close: Number(r.close),
    }));
}

function atr14FromOhlc(rows) {
    if (!Array.isArray(rows) || rows.length < 15) return null;
    // True Range = max( high-low, |high-prevClose|, |low-prevClose| )
    const TR = [];
    for (let i = 1; i < rows.length; i++) {
        const h = rows[i].high, l = rows[i].low, pc = rows[i - 1].close;
        const tr = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
        TR.push(tr);
    }
    // SMA 14 của TR
    const n = 14;
    if (TR.length < n) return null;
    const last14 = TR.slice(-n);
    const atr = last14.reduce((a, b) => a + b, 0) / n;
    return Number(atr);
}

async function getATR14(coin_id) {
    // Ưu tiên 1H; nếu thiếu thì dùng 15M (quy đổi xấp xỉ về 1H theo sqrt(time))
    const h = await getOhlcRows(coin_id, "1h", 120);
    let atr = atr14FromOhlc(h);
    if (Number.isFinite(atr) && atr > 0) return atr;

    const m15 = await getOhlcRows(coin_id, "15m", 200);
    const atr15 = atr14FromOhlc(m15);
    if (Number.isFinite(atr15) && atr15 > 0) {
        // 4 nến 15m ≈ 1 nến 1h → dùng quy tắc căn bậc hai thời gian
        return Number((atr15 * Math.sqrt(4)).toFixed(10));
    }
    return null;
}
// === End ATR(14) helpers ===

async function getCloses(coin_id, timeframe, limit = 200) {
    const { rows } = await q(
        `SELECT close FROM price_ohlc WHERE coin_id=$1 AND timeframe=$2 ORDER BY close_time ASC`,
        [coin_id, timeframe]
    );
    return rows.slice(-limit).map(r => Number(r.close));
}

async function getLatestClose(coin_id) {
    const { rows } = await q(
        `SELECT close FROM price_ohlc WHERE coin_id=$1 ORDER BY close_time DESC LIMIT 1`,
        [coin_id]
    );
    return rows[0]?.close ? Number(rows[0].close) : null;
}

async function getWhaleStats(coin_id) {
    // 24h gần nhất
    const since = dayjs().subtract(24, "hour").toDate();
    const { rows } = await q(
        `SELECT COUNT(*) AS cnt,
            COALESCE(SUM(CASE WHEN is_large THEN 1 ELSE 0 END),0) AS large_cnt,
            COALESCE(SUM(CASE WHEN direction='to_exchange' THEN amount_usd ELSE 0 END),0) AS inflow_usd,
            COALESCE(SUM(CASE WHEN direction='from_exchange' THEN amount_usd ELSE 0 END),0) AS outflow_usd
     FROM onchain_transfers
     WHERE coin_id=$1 AND block_time >= $2`,
        [coin_id, since]
    );
    const r = rows[0] || {};
    return {
        total: Number(r.cnt || 0),
        large: Number(r.large_cnt || 0),
        inflow_usd: Number(r.inflow_usd || 0),
        outflow_usd: Number(r.outflow_usd || 0),
        netflow_usd: Number(r.outflow_usd || 0) - Number(r.inflow_usd || 0)
    };
}

async function getNewsStats(coin_id) {
    const since = dayjs().subtract(48, "hour").toDate();
    const { rows } = await q(
        `SELECT COUNT(*) AS cnt FROM news_items WHERE coin_id=$1 AND published_at >= $2`,
        [coin_id, since]
    );
    return { recentCount: Number(rows[0]?.cnt || 0) };
}

// backend/services/analyzer.js
export async function analyzeCoin(symbol) {
  // map symbol -> coin_id
  const { rows: coinRows } = await q(
    `SELECT id, symbol FROM crypto_assets WHERE UPPER(symbol)=UPPER($1) AND is_active=true`,
    [symbol]
  );
  if (!coinRows.length) throw new Error(`Symbol ${symbol} not found`);
  const coin_id = coinRows[0].id;

  // prices
  const closes15 = await getCloses(coin_id, "15m", 200);
  const closes1h = await getCloses(coin_id, "1h", 200);
  const px = await getLatestClose(coin_id);
  if (!closes15.length || !px) throw new Error("Not enough price data; run price_worker first.");

  // indicators (15m)
  const rsi = RSI.calculate({ values: closes15, period: 14 }).slice(-1)[0] ?? null;
  const ema12 = EMA.calculate({ values: closes15, period: 12 }).slice(-1)[0] ?? null;
  const ema26 = EMA.calculate({ values: closes15, period: 26 }).slice(-1)[0] ?? null;
  const macdArr = MACD.calculate({
    values: closes15,
    fastPeriod: 12, slowPeriod: 26, signalPeriod: 9,
    SimpleMAOscillator: false, SimpleMASignal: false
  });
  const macd = macdArr.slice(-1)[0] ?? null;

  // indicators (1h) - confluence nhẹ
  const rsi1h = closes1h.length ? (RSI.calculate({ values: closes1h, period: 14 }).slice(-1)[0] ?? null) : null;

  // normalize signals 0..1
  const rsiSig   = rsi   != null ? (rsi   <= 30 ? 0.85 : rsi   < 50 ? 0.65 : rsi   < 60 ? 0.50 : 0.30) : 0.50;
  const rsi1hSig = rsi1h != null ? (rsi1h <= 30 ? 0.80 : rsi1h < 50 ? 0.60 : rsi1h < 60 ? 0.45 : 0.30) : 0.50;
  const momentumSig = (ema12 && ema26) ? (ema12 > ema26 ? 0.70 : 0.30) : 0.50;
  const macdSig = macd ? (macd.histogram > 0
    ? normalize01(macd.histogram, 0, Math.abs(macd.histogram) * 2)
    : 0.30)
    : 0.50;

  // whale/on-chain (24h)
  const whale = await getWhaleStats(coin_id);
  const netflowSig = (whale.netflow_usd > 0) ? 0.65 : (whale.netflow_usd < 0 ? 0.35 : 0.50);
  const largeSig   = (whale.large >= 3) ? (whale.netflow_usd > 0 ? 0.60 : 0.40) : 0.50;

  // news (48h)
  const news = await getNewsStats(coin_id);
  const newsSig = (news.recentCount >= 10) ? 0.60 : (news.recentCount >= 3 ? 0.55 : 0.50);

  // === ATR(14) & vùng giá
  const atr = await getATR14(coin_id);
  const ATR_OK = Number.isFinite(atr) && atr > 0;

  let buy_zone_min = null, buy_zone_max = null;
  let stop_loss = null, take_profit_1 = null, take_profit_2 = null;
  let reentry_zone = null;

  // Tính tổng điểm (điều chỉnh trọng số để thêm RSI(1h))
  const weights = {
    rsiSig: 0.17, rsi1hSig: 0.13, momentumSig: 0.18, macdSig: 0.12,
    netflowSig: 0.25, largeSig: 0.08, newsSig: 0.07,
  };
  const score =
    rsiSig   * weights.rsiSig   +
    rsi1hSig * weights.rsi1hSig +
    momentumSig * weights.momentumSig +
    macdSig  * weights.macdSig  +
    netflowSig * weights.netflowSig +
    largeSig * weights.largeSig +
    newsSig  * weights.newsSig;

  const overall = clamp(score, 0, 1);

  // action & confidence
  let action = "HOLD", confidence = "medium";
  if (overall >= 0.75) action = "STRONG_BUY";
  else if (overall >= 0.58) action = "BUY";
  else if (overall <= 0.25) action = "STRONG_SELL";
  else if (overall <= 0.42) action = "SELL";

  if (overall >= 0.7 || overall <= 0.3) confidence = "high";

  // thêm điều chỉnh confidence theo độ biến động (ATR%)
  const atrPct = ATR_OK ? (atr / px) : null;
  if (atrPct != null) {
    if (atrPct > 0.06 && confidence === "high") confidence = "medium";
    if (atrPct > 0.10) confidence = "low";
    if (atrPct < 0.02 && confidence === "medium") confidence = "high";
  }

  if (action === "SELL" || action === "STRONG_SELL") {
    // Re-entry zone (đợi chiết khấu)
    if (ATR_OK) {
      const reMin = Number((px - 1.5 * atr).toFixed(6));
      const reMax = Number((px - 0.7 * atr).toFixed(6));
      reentry_zone = [Math.min(reMin, reMax), Math.max(reMin, reMax)];
    } else {
      const reMin = Number((px * 0.94).toFixed(6));
      const reMax = Number((px * 0.97).toFixed(6));
      reentry_zone = [Math.min(reMin, reMax), Math.max(reMin, reMax)];
    }
  } else {
    if (ATR_OK) {
      buy_zone_min = Number((px - 1.0 * atr).toFixed(6));
      buy_zone_max = Number((px - 0.5 * atr).toFixed(6));
      stop_loss    = Number((px - 2.0 * atr).toFixed(6));
      take_profit_1= Number((px + 1.5 * atr).toFixed(6));
      take_profit_2= Number((px + 2.5 * atr).toFixed(6));
    } else {
      buy_zone_min = Number((px * 0.985).toFixed(6));
      buy_zone_max = Number((px * 0.97).toFixed(6));
      stop_loss    = Number((px * 0.96).toFixed(6));
      take_profit_1= Number((px * 1.09).toFixed(6));
      take_profit_2= Number((px * 1.15).toFixed(6));
    }
  }

  // === LƯU DB: BẮT BUỘC phải chứa atr + reentry_zone để FE đọc ===
  const dataForDb = { px, whale, news, rsi, rsi1h, ema12, ema26, macd, atr, reentry_zone };

  const { rows: ins } = await q(
    `INSERT INTO coin_analysis
     (coin_id, overall_score, action, confidence, buy_zone_min, buy_zone_max, stop_loss, take_profit_1, take_profit_2, data)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING id, run_at`,
    [coin_id, overall, action, confidence,
     buy_zone_min, buy_zone_max, stop_loss, take_profit_1, take_profit_2, dataForDb]
  );
  const analysis_id = ins[0].id;

  const signals = [
    { name: "RSI_14_15m",   score: rsiSig,   severity: rsi   != null ? (rsi   < 30 ? "high" : rsi   < 50 ? "medium" : "low") : "low", details: { rsi } },
    { name: "RSI_14_1h",    score: rsi1hSig, severity: rsi1h != null ? (rsi1h < 30 ? "high" : rsi1h < 50 ? "medium" : "low") : "low", details: { rsi1h } },
    { name: "EMA_12_26",    score: momentumSig, severity: "medium", details: { ema12, ema26 } },
    { name: "MACD",         score: macdSig,     severity: "medium", details: { macd } },
    { name: "Exchange_Net_Flow", score: netflowSig, severity: "medium", details: whale },
    { name: "Whale_Large_Transfers", score: largeSig, severity: "medium", details: { large: whale.large } },
    { name: "News_Activity", score: newsSig, severity: "low", details: news },
    { name: "ATR14", score: ATR_OK ? normalize01(atrPct ?? 0.03, 0, 0.1) : 0.5, severity: "info", details: { atr, atrPct } }
  ];
  for (const s of signals) {
    await q(
      `INSERT INTO coin_signals (analysis_id, name, score, severity, details)
       VALUES ($1,$2,$3,$4,$5)`,
      [analysis_id, s.name, s.score, s.severity, s.details]
    );
  }

  return {
    symbol: coinRows[0].symbol,
    overall_score: Number(overall.toFixed(4)),
    action, confidence,
    buy_zone: [buy_zone_min, buy_zone_max],
    stop_loss, take_profit: [take_profit_1, take_profit_2],
    run_at: ins[0].run_at
  };
}

