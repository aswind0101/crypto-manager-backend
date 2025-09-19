// backend/workers/price_worker.js
import axios from "axios";
import dayjs from "dayjs";
import { q } from "../utils/db.js";

const CG_BASE = process.env.COINGECKO_API_BASE || "https://api.coingecko.com/api/v3";
const CG_KEY  = process.env.COINGECKO_API_KEY || "";

/**
 * Lấy ohlc từ CoinGecko:
 *  - 1d => 24h candle (timeframe 1h)
 *  - 1 => 1 ngày cho daily; ta dùng endpoints market_chart
 */
async function fetchOhlcForCoin({ id, coingecko_id }) {
  // Lấy 1h candles trong ~2 ngày (để đủ dữ liệu tính chỉ báo)
  // CoinGecko /coins/{id}/market_chart?vs_currency=usd&days=2&interval=hourly
  const url1h = `${CG_BASE}/coins/${coingecko_id}/market_chart?vs_currency=usd&days=2&interval=hourly${CG_KEY ? `&x_cg_pro_api_key=${CG_KEY}` : ""}`;
  const urlMin = `${CG_BASE}/coins/${coingecko_id}/market_chart?vs_currency=usd&days=2&interval=5m${CG_KEY ? `&x_cg_pro_api_key=${CG_KEY}` : ""}`;

  const [hResp, mResp] = await Promise.all([
    axios.get(url1h),
    axios.get(urlMin)
  ]);

  // CG trả về mảng [timestamp, price]/[timestamp, total_volumes]
  // Không có OHLC chuẩn; ta dựng OHLC từ dữ liệu 5m & hourly (approx)
  // Đơn giản: với hourly: treat price[] làm "close", open = prev close, high/low theo min/max window
  const insertRows = [];

  const toOhlc = (prices, volumes, intervalLabel) => {
    if (!Array.isArray(prices)) return;
    for (let i = 1; i < prices.length; i++) {
      const [tPrev, pPrev] = prices[i - 1];
      const [tCur, pCur] = prices[i];
      const openTime = dayjs(tPrev).toDate();
      const closeTime = dayjs(tCur).toDate();
      const open = pPrev;
      const close = pCur;

      // High/Low xấp xỉ từ đoạn 2 giá; nếu có 5m chi tiết sẽ chính xác hơn
      const high = Math.max(open, close);
      const low  = Math.min(open, close);

      // Volume xấp xỉ theo volumes[i][1] - volumes[i-1][1] nếu có
      let vol = null;
      if (Array.isArray(volumes) && volumes[i] && volumes[i-1]) {
        const d = volumes[i][1] - volumes[i-1][1];
        vol = d >= 0 ? d : null;
      }

      insertRows.push({
        coin_id: id,
        timeframe: intervalLabel,
        open_time: openTime,
        close_time: closeTime,
        open, high, low, close,
        volume: vol,
        source: "coingecko",
      });
    }
  };

  toOhlc(hResp.data?.prices, hResp.data?.total_volumes, "1h");
  toOhlc(mResp.data?.prices, mResp.data?.total_volumes, "15m");

  // upsert
  const client = await q("SELECT 1"); // ensure pool init
  for (const row of insertRows) {
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

  return insertRows.length;
}

export async function runPriceWorker() {
  // lấy danh sách coin active
  const { rows: coins } = await q(`SELECT id, symbol, coingecko_id FROM crypto_assets WHERE is_active = true`);
  let total = 0;
  for (const c of coins) {
    if (!c.coingecko_id) continue;
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

// Nếu chạy file trực tiếp
if (process.argv[1] && process.argv[1].endsWith("price_worker.js")) {
  runPriceWorker().then(() => process.exit(0)).catch(() => process.exit(1));
}
