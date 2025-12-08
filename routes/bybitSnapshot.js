// routes/bybitSnapshot.js
import express from "express";
import axios from "axios";

const router = express.Router();

// Có thể đổi sang process.env.BYBIT_BASE nếu muốn cấu hình linh hoạt
const BYBIT_BASE = "https://api.bybit.com";

/**
 * Gọi Bybit với axios, có log chi tiết lỗi (status, body)
 */
async function getFromBybit(path, params = {}) {
    try {
        const url = new URL(path, BYBIT_BASE);

        Object.entries(params).forEach(([key, value]) => {
            if (value !== undefined && value !== null) {
                url.searchParams.append(key, String(value));
            }
        });

        // Thêm User-Agent cho chắc ăn
        const { data } = await axios.get(url.toString(), {
            timeout: 10000,
            headers: {
                "User-Agent": "onetool-btc-trending/1.0"
            }
        });

        if (data.retCode !== 0) {
            console.error("Bybit retCode error:", data.retCode, data.retMsg);
            throw new Error(`Bybit retCode ${data.retCode}: ${data.retMsg}`);
        }

        return data.result || {};
    } catch (error) {
        // Nếu Bybit trả HTTP error (403, 404, 5xx...)
        if (error.response) {
            console.error("Bybit HTTP error:", {
                status: error.response.status,
                statusText: error.response.statusText,
                data: error.response.data,
                url: error.config?.url,
            });

            // Ném error rõ ràng hơn để Express trả ra cho mình xem
            throw new Error(
                `Bybit HTTP ${error.response.status} ${error.response.statusText}: ` +
                `${JSON.stringify(error.response.data)}`
            );
        }

        // Lỗi khác (timeout, network,...)
        console.error("Bybit request error:", error.message || error);
        throw new Error(error.message || "Unknown Bybit request error");
    }
}

// =============== Helpers gọi từng loại dữ liệu ===============

async function getKlines(symbol, intervals = ["1", "5", "15", "60", "240", "D"], limit = 200) {
    const klines = {};
    for (const interval of intervals) {
        const result = await getFromBybit("/v5/market/kline", {
            category: "linear",
            symbol,
            interval,
            limit,
        });
        klines[interval] = result.list || [];
    }
    return klines;
}

async function getOpenInterest(symbol, intervalTime = "5min", limit = 200) {
    const result = await getFromBybit("/v5/market/open-interest", {
        category: "linear",
        symbol,
        intervalTime,
        limit,
    });
    return result.list || [];
}

async function getLongShortRatio(symbol, period = "1h", limit = 100) {
    const result = await getFromBybit("/v5/market/account-ratio", {
        category: "linear",
        symbol,
        period,
        limit,
    });
    return result.list || [];
}

async function getFundingHistory(symbol, limit = 50) {
    const result = await getFromBybit("/v5/market/funding/history", {
        category: "linear",
        symbol,
        limit,
    });
    return result.list || [];
}

async function getOrderbook(symbol, limit = 25) {
    const result = await getFromBybit("/v5/market/orderbook", {
        category: "linear",
        symbol,
        limit,
    });
    return {
        bids: result.b || [],
        asks: result.a || [],
    };
}

async function getRecentTrades(symbol, limit = 500) {
    const result = await getFromBybit("/v5/market/recent-trade", {
        category: "linear",
        symbol,
        limit,
    });
    return result.list || [];
}

async function getTicker(symbol) {
    const result = await getFromBybit("/v5/market/tickers", {
        category: "linear",
        symbol,
    });
    const list = result.list || [];
    return list[0] || {};
}

// Gom full data cho 1 symbol
async function collectSymbolData(symbol) {
    return {
        symbol,
        klines: await getKlines(symbol),
        open_interest: await getOpenInterest(symbol),
        long_short_ratio: await getLongShortRatio(symbol),
        funding_history: await getFundingHistory(symbol),
        orderbook: await getOrderbook(symbol),
        recent_trades: await getRecentTrades(symbol),
        ticker: await getTicker(symbol),
    };
}

// =============== Stub cho on-chain & global derivatives v2 ===============

// =============== On-chain via Dune ===============

const DUNE_API_KEY = process.env.DUNE_API_KEY || "";
const DUNE_QUERY_ID_EXCHANGE_NETFLOW_BTC =
  process.env.DUNE_QUERY_ID_EXCHANGE_NETFLOW_BTC || "";
const DUNE_QUERY_ID_WHALE_FLOWS_BTC =
  process.env.DUNE_QUERY_ID_WHALE_FLOWS_BTC || "";

const DUNE_BASE = "https://api.dune.com/api/v1";

// Chuẩn hoá timestamp về ms
function normalizeToMs(value) {
  if (value == null) return null;
  const num = Number(value);
  if (Number.isFinite(num)) {
    if (num > 1e11) return num;      // đã là ms
    if (num > 0) return num * 1000;  // seconds -> ms
  }
  const d = new Date(value);
  if (!isNaN(d.getTime())) return d.getTime();
  return null;
}

// Gọi Dune, trả về rows
async function getFromDune(queryId, params = {}) {
  if (!DUNE_API_KEY) {
    console.warn("[Dune] DUNE_API_KEY is not set – onchain will be empty.");
    return [];
  }
  if (!queryId) {
    console.warn("[Dune] Missing queryId – onchain will be empty.");
    return [];
  }

  try {
    const url = new URL(`/query/${queryId}/results`, DUNE_BASE);

    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null) {
        url.searchParams.append(key, String(value));
      }
    });

    const { data } = await axios.get(url.toString(), {
      timeout: 15000,
      headers: {
        "X-Dune-Api-Key": DUNE_API_KEY,
      },
    });

    const rows =
      (data.result && data.result.rows) ||
      (data.data && data.data.rows) ||
      data.rows ||
      [];

    if (!Array.isArray(rows)) return [];
    return rows;
  } catch (err) {
    console.error(
      "[Dune] getFromDune error:",
      err.response?.data || err.message || err
    );
    return [];
  }
}

// Netflow daily (aggregate hoặc per-exchange tuỳ query)
async function fetchExchangeNetflowDailyFromDune(asset = "BTC") {
  if (!DUNE_QUERY_ID_EXCHANGE_NETFLOW_BTC) return [];

  const rows = await getFromDune(DUNE_QUERY_ID_EXCHANGE_NETFLOW_BTC, {
    asset,
  });

  return rows
    .map((r) => {
      const t =
        normalizeToMs(
          r.time ?? r.day ?? r.block_time ?? r.timestamp ?? r.ts
        ) || null;

      const netflowRaw =
        r.netflow ?? r.net_flow ?? r.value ?? r.net ?? null;
      const netflow = Number(netflowRaw);

      if (!t || !Number.isFinite(netflow)) return null;

      return {
        asset,
        t,
        netflow,
        exchange: r.exchange || "all", // nếu query là aggregate thì để "all"
        source: "dune",
      };
    })
    .filter(Boolean);
}

// Whale flows (deposit/withdraw lên sàn)
async function fetchWhaleExchangeFlowsFromDune(asset = "BTC") {
  if (!DUNE_QUERY_ID_WHALE_FLOWS_BTC) return [];

  const rows = await getFromDune(DUNE_QUERY_ID_WHALE_FLOWS_BTC, {
    asset,
  });

  return rows
    .map((r) => {
      const t =
        normalizeToMs(
          r.time ?? r.day ?? r.block_time ?? r.timestamp ?? r.ts
        ) || null;

      const amountRaw = r.amount ?? r.volume ?? r.value ?? null;
      const amount = Number(amountRaw);

      if (!t || !Number.isFinite(amount) || amount <= 0) return null;

      let direction = (r.direction || "").toLowerCase();
      if (!direction) {
        if (r.to_exchange) direction = "deposit";
        else if (r.from_exchange) direction = "withdraw";
        else direction = "net";
      }

      const txCount =
        r.tx_count != null ? Number(r.tx_count) : null;
      const avgTx =
        r.avg_tx_size != null ? Number(r.avg_tx_size) : null;

      return {
        asset,
        t,
        direction, // "deposit" | "withdraw" | "net"
        amount,
        exchange:
          r.exchange || r.to_exchange || r.from_exchange || "all",
        tx_count: Number.isFinite(txCount) ? txCount : null,
        avg_tx_size: Number.isFinite(avgTx) ? avgTx : null,
        source: "dune",
      };
    })
    .filter(Boolean);
}

// Hàm chính build block onchain cho 1 asset
async function fetchOnchainData(asset = "BTC") {
  try {
    const [netflow, whaleFlows] = await Promise.all([
      fetchExchangeNetflowDailyFromDune(asset),
      fetchWhaleExchangeFlowsFromDune(asset),
    ]);

    return {
      exchange_netflow_daily: netflow || [],
      whale_exchange_flows: whaleFlows || [],
    };
  } catch (err) {
    console.error(
      "fetchOnchainData (Dune) error:",
      err.response?.data || err.message || err
    );
    return {
      exchange_netflow_daily: [],
      whale_exchange_flows: [],
    };
  }
}


const COINGLASS_API_KEY = process.env.COINGLASS_API_KEY;

async function fetchGlobalDerivatives() {
    if (!COINGLASS_API_KEY) {
        console.warn("COINGLASS_API_KEY is not set, global_derivatives will be empty.");
        return {
            total_oi: [],
            funding_mean: [],
            estimated_leverage_ratio: [],
        };
    }

    // Tùy docs, header có thể là 'coinglassSecret' hoặc 'CG-API-KEY'
    // Bạn check lại phần "Credentials / Header" trong docs CoinGlass rồi chỉnh đúng.
    const headers = {
        accept: "application/json",
        "CG-API-KEY": COINGLASS_API_KEY,
        // hoặc: "coinglassSecret": COINGLASS_API_KEY,
    };

    try {
        // 1) Lấy OI tổng hợp tất cả sàn cho BTC
        const oiRes = await axios.get(
            "https://open-api-v4.coinglass.com/api/futures/open-interest/exchange-list",
            {
                params: { symbol: "BTC" },
                headers,
            }
        );

        const oiData = oiRes.data?.data || [];
        const agg = oiData.find((d) => d.exchange === "All");

        const now = Date.now();
        const total_oi = agg
            ? [
                {
                    t: now,
                    oi_usd: agg.open_interest_usd,
                    oi_quantity: agg.open_interest_quantity,
                },
            ]
            : [];

        // 2) Funding rate history cho BTC (dạng OHLC)
        const frRes = await axios.get(
            "https://open-api-v4.coinglass.com/api/futures/funding-rate/history",
            {
                // ⚠️ Các params cụ thể (symbol, pair, interval) bạn xem lại trong docs
                // ví dụ dạng: { symbol: "BTC", interval: "8h" }
                params: {
                    symbol: "BTC",
                    interval: "8h",
                },
                headers,
            }
        );

        const frList = frRes.data?.data || [];
        const funding_mean = frList.map((c) => ({
            t: c.time, // ms
            funding_open: Number(c.open),
            funding_high: Number(c.high),
            funding_low: Number(c.low),
            funding_close: Number(c.close),
        }));

        // 3) estimated_leverage_ratio – phase 1: để rỗng,
        // hoặc bạn có thể tự tính sau này: OI notional / market cap, v.v.
        const estimated_leverage_ratio = [];

        return {
            total_oi,
            funding_mean,
            estimated_leverage_ratio,
        };
    } catch (err) {
        console.error("fetchGlobalDerivatives error:", err.response?.data || err.message);
        return {
            total_oi: [],
            funding_mean: [],
            estimated_leverage_ratio: [],
        };
    }
}

// =============== Route chính: /api/bybit/snapshot (v2) ===============

// GET /api/bybit/snapshot?symbols=BTCUSDT,ETHUSDT,SOLUSDT
router.get("/snapshot", async (req, res) => {
    try {
        const symbolsParam = (req.query.symbols || "").toString().trim();
        if (!symbolsParam) {
            return res.status(400).json({ error: "Missing symbols param" });
        }

        const symbols = symbolsParam
            .split(",")
            .map((s) => s.trim().toUpperCase())
            .filter(Boolean);

        if (symbols.length === 0) {
            return res.status(400).json({ error: "No valid symbols provided" });
        }

        const generatedAt = Date.now();

        const symbolsData = [];
        for (const sym of symbols) {
            const data = await collectSymbolData(sym);
            symbolsData.push(data);
        }

        // Lấy stub onchain & global derivatives song song
        const [onchain, globalDerivatives] = await Promise.all([
            fetchOnchainData(),
            fetchGlobalDerivatives()
        ]);

        const payload = {
            version: 2,
            generated_at: generatedAt,
            per_exchange: {
                bybit: {
                    category: "linear",
                    symbols: symbolsData,
                },
            },
            onchain,
            global_derivatives: globalDerivatives,
        };

        return res.json(payload);
    } catch (err) {
        console.error("Error in /api/bybit/snapshot:", err.message || err);
        return res.status(500).json({ error: err.message || "Internal Server Error" });
    }
});

// =============== Route phụ: /api/bybit/onchain?asset=BTC ===============

router.get("/onchain", async (req, res) => {
  try {
    const asset = (req.query.asset || "BTC").toString().toUpperCase();

    const onchain = await fetchOnchainData(asset);

    return res.json(onchain);
  } catch (err) {
    console.error("Error in /api/bybit/onchain:", err.message || err);
    return res.status(500).json({
      exchange_netflow_daily: [],
      whale_exchange_flows: [],
      error: err.message || "Internal Server Error",
    });
  }
});

export default router;
