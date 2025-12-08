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

const GLASSNODE_API_KEY = process.env.GLASSNODE_API_KEY;

async function fetchOnchainData() {
    // Nếu chưa cấu hình API key, trả rỗng nhưng không làm hỏng snapshot
    if (!GLASSNODE_API_KEY) {
        console.warn("GLASSNODE_API_KEY is not set, onchain data will be empty.");
        return {
            exchange_netflow_daily: [],
            whale_exchange_flows: [],
        };
    }

    const base = "https://api.glassnode.com/v1/metrics";

    try {
        // 1) Net position change trên sàn (proxy cho netflow dài hạn)
        const netflowRes = await axios.get(
            `${base}/distribution/exchange_net_position_change`,
            {
                params: {
                    api_key: GLASSNODE_API_KEY, // bắt buộc
                    a: "BTC",                   // asset
                    i: "24h",                   // interval daily
                    // s, u: since / until (unix sec) – có thể thêm sau nếu muốn giới hạn thời gian
                },
            }
        );

        // 2) Tổng BTC trên tất cả sàn
        const balanceRes = await axios.get(
            `${base}/distribution/balance_exchanges_all`,
            {
                params: {
                    api_key: GLASSNODE_API_KEY,
                    a: "BTC",
                    i: "24h",
                },
            }
        );

        // Glassnode trả về dạng [{ t: unix_sec, v: value }, ...]
        const netflowMap = new Map();
        for (const point of netflowRes.data || []) {
            netflowMap.set(point.t, point.v);
        }

        const balanceMap = new Map();
        for (const point of balanceRes.data || []) {
            balanceMap.set(point.t, point.v);
        }

        // Gộp theo timestamp
        const allTimestamps = Array.from(
            new Set([...netflowMap.keys(), ...balanceMap.keys()])
        ).sort((a, b) => a - b);

        const exchange_netflow_daily = allTimestamps.map((t) => ({
            // nhân 1000 để về ms cho đồng bộ với bybit_snapshot
            t: t * 1000,
            netflow_btc: netflowMap.get(t) ?? null,
            balance_btc: balanceMap.get(t) ?? null,
        }));

        // Whale flows – phase 1: để rỗng hoặc sau này bạn có thể dùng thêm metric khác
        const whale_exchange_flows = [];

        return {
            exchange_netflow_daily,
            whale_exchange_flows,
        };
    } catch (err) {
        console.error("fetchOnchainData error:", err.response?.data || err.message);
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

export default router;
