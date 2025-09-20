// backend/workers/price_worker.js
import axios from "axios";
import dayjs from "dayjs";
import { q } from "../utils/db.js";

const BINANCE_BASE = process.env.BINANCE_API_BASE || "https://api.binance.us";
const CG_BASE = process.env.COINGECKO_API_BASE || "https://api.coingecko.com/api/v3";
const CG_KEY  = process.env.COINGECKO_API_KEY || "";

function sleep(ms){ return new Promise(r=>setTimeout(r, ms)); }

async function upsertRows(rows) {
  for (const row of rows) {
    await q(
      `INSERT INTO price_ohlc
       (coin_id, timeframe, open_time, close_time, open, high, low, close, volume, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (coin_id, timeframe, open_time, source)
       DO UPDATE SET close_time = EXCLUDED.close_time,
                     open = EXCLUDED.open,
                     high = GREATEST(price_ohlc.high, EXCLUDED.high),
                     low  = LEAST(price_ohlc.low, EXCLUDED.low),
                     close = EXCLUDED.close,
                     volume = COALESCE(EXCLUDED.volume, price_ohlc.volume)`,
      [
        row.coin_id, row.timeframe, row.open_time, row.close_time,
        row.open, row.high, row.low, row.close, row.volume, row.source
      ]
    );
  }
  return rows.length;
}

/* ====================== BINANCE (PRIMARY) ====================== */
function msToDate(ms){ return dayjs(ms).toDate(); }

async function fetchFromBinance(coin) {
  if (!coin.binance_symbol) throw new Error("binance_symbol_missing");

  async function getKlines(interval, limit=300){
    const url = `${BINANCE_BASE}/api/v3/klines?symbol=${coin.binance_symbol}&interval=${interval}&limit=${limit}`;
    const { data } = await axios.get(url, { headers: { "User-Agent":"crypto-manager/1.0" }});
    // [openTime, open, high, low, close, volume, closeTime, ...]
    return data.map(k => ({
      open_time: msToDate(k[0]),
      open: Number(k[1]),
      high: Number(k[2]),
      low:  Number(k[3]),
      close:Number(k[4]),
      volume:Number(k[5]),
      close_time: msToDate(k[6]),
    }));
  }

  const rows = [];
  const ivs = [{tf:"15m", iv:"15m"}, {tf:"1h", iv:"1h"}];

  for (const {tf, iv} of ivs) {
    const kl = await getKlines(iv, 500);
    for (const c of kl) {
      rows.push({
        coin_id: coin.id, timeframe: tf,
        open_time: c.open_time, close_time: c.close_time,
        open: c.open, high: c.high, low: c.low, close: c.close,
        volume: c.volume, source: "binance"
      });
    }
  }

  const n = await upsertRows(rows);
  console.log(`price_worker: ${coin.symbol} <- Binance OK (${n} rows)`);
  return n;
}

/* ====================== COINGECKO (FALLBACK) ====================== */
async function fetchFromCoingecko(coin) {
  if (!coin.coingecko_id) throw new Error("coingecko_id_missing");

  const headers = { "User-Agent": "crypto-manager/1.0" };
  const keyQuery = CG_KEY ? `&x_cg_pro_api_key=${CG_KEY}` : "";
  const url1h  = `${CG_BASE}/coins/${coin.coingecko_id}/market_chart?vs_currency=usd&days=2&interval=hourly${keyQuery}`;
  const url15m = `${CG_BASE}/coins/${coin.coingecko_id}/market_chart?vs_currency=usd&days=2&interval=5m${keyQuery}`;

  let hResp, mResp;
  for (let i=0;i<2;i++){
    try {
      [hResp, mResp] = await Promise.all([axios.get(url1h, {headers}), axios.get(url15m,{headers})]);
      break;
    } catch (e) {
      if ((e.response?.status === 429 || e.response?.status === 451) && i===0) { await sleep(1500); continue; }
      throw e;
    }
  }

  const rows = [];
  const toOhlc = (prices, volumes, label) => {
    if (!Array.isArray(prices)) return;
    for (let i = 1; i < prices.length; i++) {
      const [tPrev, pPrev] = prices[i - 1];
      const [tCur, pCur]   = prices[i];
      const openTime  = dayjs(tPrev).toDate();
      const closeTime = dayjs(tCur).toDate();
      const open  = Number(pPrev);
      const close = Number(pCur);
      const high  = Math.max(open, close);
      const low   = Math.min(open, close);
      let vol = null;
      if (Array.isArray(volumes) && volumes[i] && volumes[i-1]) {
        const d = volumes[i][1] - volumes[i-1][1];
        vol = d >= 0 ? Number(d) : null;
      }
      rows.push({
        coin_id: coin.id, timeframe: label, open_time: openTime, close_time: closeTime,
        open, high, low, close, volume: vol, source: "coingecko"
      });
    }
  };

  toOhlc(hResp.data?.prices, hResp.data?.total_volumes, "1h");
  toOhlc(mResp.data?.prices, mResp.data?.total_volumes, "15m");

  const n = await upsertRows(rows);
  console.log(`price_worker: ${coin.symbol} <- CoinGecko OK (${n} rows)`);
  return n;
}

/* ====================== RUNNER ====================== */
export async function fetchOhlcForCoin(coin){
  // Try BINANCE first
  try {
    const nB = await fetchFromBinance(coin);
    if (nB > 0) return nB;
  } catch (e) {
    console.warn(`price_worker: ${coin.symbol} Binance failed:`, e.message);
  }
  // Fallback to COINGECKO
  try {
    const nC = await fetchFromCoingecko(coin);
    return nC;
  } catch (e) {
    console.warn(`price_worker: ${coin.symbol} CoinGecko failed:`, e.message);
    throw e;
  }
}

export async function runPriceWorker() {
  const { rows: coins } = await q(`SELECT id, symbol, coingecko_id, binance_symbol FROM crypto_assets WHERE is_active = true`);
  let total = 0;
  for (const c of coins) {
    try {
      const n = await fetchOhlcForCoin(c);
      total += n;
    } catch (e) {
      console.error(`price_worker: ${c.symbol} error:`, e.message);
    }
  }
  console.log(`price_worker: upserted ${total} OHLC rows`);
  return total;
}

if (process.argv[1] && process.argv[1].endsWith("price_worker.js")) {
  runPriceWorker().then(()=>process.exit(0)).catch(()=>process.exit(1));
}
