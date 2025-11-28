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

// =============== Route chính: /api/bybit/snapshot ===============

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

        const payload = {
            exchange: "bybit",
            category: "linear",
            generated_at: generatedAt,
            symbols: symbolsData,
        };

        return res.json(payload);
    } catch (err) {
        console.error("Error in /api/bybit/snapshot:", err.message || err);
        return res.status(500).json({ error: err.message || "Internal Server Error" });
    }
});

export default router;
