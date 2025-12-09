// routes/bybitSnapshot.js
import express from "express";
import axios from "axios";

const router = express.Router();

// Có thể đổi sang process.env.BYBIT_BASE nếu muốn cấu hình linh hoạt
const BYBIT_BASE = "https://api.bybit.com";

// Chuẩn hóa input (BTC, BTCUSDT, ETHUSDT...) về base asset (BTC, ETH, LINK...)
function normalizeToBaseAsset(value = "BTC") {
    const raw = value.toString().toUpperCase().trim();
    if (!raw) return "BTC";

    // Một số hậu tố phổ biến trên perp
    const suffixes = ["USDT", "USDC", "BUSD", "USD", "PERP"];

    for (const suf of suffixes) {
        if (raw.endsWith(suf) && raw.length > suf.length + 1) {
            return raw.slice(0, -suf.length);
        }
    }

    // Nếu không khớp hậu tố nào -> coi như đã là asset (BTC, ETH, LINK...)
    return raw;
}

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
const DUNE_QUERY_ID_ONCHAIN_COMBINED =
    process.env.DUNE_QUERY_ID_ONCHAIN_COMBINED || "";

const DUNE_API_KEY = process.env.DUNE_API_KEY || "";
const DUNE_QUERY_ID_EXCHANGE_NETFLOW_BTC =
    process.env.DUNE_QUERY_ID_EXCHANGE_NETFLOW_BTC || "";
const DUNE_QUERY_ID_WHALE_FLOWS_BTC =
    process.env.DUNE_QUERY_ID_WHALE_FLOWS_BTC || "";

const DUNE_BASE = "https://api.dune.com/api/v1/";

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

// Gọi Dune bằng flow execute -> poll kết quả, có hỗ trợ query params ({{asset}})
async function getFromDune(
    queryId,
    params = {},
    options = {}
) {
    if (!DUNE_API_KEY) {
        console.warn("[Dune] DUNE_API_KEY is not set – onchain will be empty.");
        return [];
    }
    if (!queryId) {
        console.warn("[Dune] Missing queryId – onchain will be empty.");
        return [];
    }

    // Có thể custom theo từng loại query
    const maxAttempts = options.maxAttempts ?? 30;   // mặc định: poll tối đa 30 lần
    const delayMs = options.delayMs ?? 2000;         // mỗi lần cách nhau 2s  -> ~60s

    try {
        // 1) Execute query với query_parameters
        const execUrl = new URL(`query/${queryId}/execute`, DUNE_BASE);

        const execBody = {
            query_parameters: params, // ví dụ: { asset: "LINK" }
        };

        const execRes = await axios.post(execUrl.toString(), execBody, {
            timeout: 15000,
            headers: {
                "X-Dune-Api-Key": DUNE_API_KEY,
                "Content-Type": "application/json",
            },
        });

        const executionId =
            execRes.data.execution_id ||
            execRes.data.executionId ||
            execRes.data.id;

        if (!executionId) {
            console.error("[Dune] execute response không có execution_id:", execRes.data);
            return [];
        }

        // 2) Poll kết quả qua /execution/{execution_id}/results
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            const resultUrl = new URL(
                `execution/${executionId}/results`,
                DUNE_BASE
            );

            const { data } = await axios.get(resultUrl.toString(), {
                timeout: 15000,
                headers: {
                    "X-Dune-Api-Key": DUNE_API_KEY,
                },
            });

            const state =
                data.state ||
                data.execution_state ||
                data.status ||
                "";

            const rows =
                (data.result && data.result.rows) ||
                (data.data && data.data.rows) ||
                data.rows ||
                [];

            if (state === "QUERY_STATE_COMPLETED" || state === "completed") {
                return Array.isArray(rows) ? rows : [];
            }

            if (state === "QUERY_STATE_FAILED" || state === "failed") {
                console.error("[Dune] execution failed:", data);
                return [];
            }

            // Nếu vẫn pending thì chờ một chút rồi thử lại
            await new Promise((resolve) => setTimeout(resolve, delayMs));
        }

        console.warn(
            "[Dune] execution timeout, không lấy được kết quả trong giới hạn poll"
        );
        return [];
    } catch (err) {
        console.error(
            "[Dune] getFromDune error:",
            err.response?.data || err.message || err
        );
        return [];
    }
}

async function fetchOnchainFromDuneCombined(asset = "BTC") {
    // Nếu chưa cấu hình ID query gộp thì trả rỗng
    if (!DUNE_QUERY_ID_ONCHAIN_COMBINED) {
        return {
            exchange_netflow_daily: [],
            whale_exchange_flows: [],
            whale_summary: {},
        };
    }

    const base = normalizeToBaseAsset(asset); // Ví dụ: LINKUSDT -> LINK

    const rows = await getFromDune(
        DUNE_QUERY_ID_ONCHAIN_COMBINED,
        { asset: base.toUpperCase() },
        { maxAttempts: 30, delayMs: 2000 }
    );

    const exchangeNetflow = [];
    const whaleFlows = [];

    for (const r of rows || []) {
        const rowType = (r.row_type || r.rowType || "").toString().toLowerCase();
        const t = normalizeToMs(r.t);

        if (!t) continue;

        const assetSym = (r.asset || base).toString().toUpperCase();

        // ----- NETFLOW DAILY -----
        if (rowType === "netflow_daily") {
            exchangeNetflow.push({
                asset: assetSym,
                t,
                netflow: Number(r.netflow ?? 0),
                netflow_usd: Number(r.netflow_usd ?? 0),
                exchange: "all",
                source: "dune",
            });
        }

        // ----- WHALE FLOWS -----
        else if (rowType === "whale_flow") {
            const amountUsd = Number(r.amount_usd ?? 0);
            if (!Number.isFinite(amountUsd) || amountUsd <= 0) continue;

            const exchangeName = String(r.exchange ?? "all");

            whaleFlows.push({
                asset: assetSym,
                t,
                direction: (r.direction || "").toLowerCase(),
                exchange: exchangeName,
                amount: Number(r.amount ?? 0),
                amount_usd: amountUsd,
                source: "dune",
            });

        }
    }

    return {
        exchange_netflow_daily: exchangeNetflow,
        whale_exchange_flows: whaleFlows,
        whale_summary: buildWhaleSummary(whaleFlows),
    };
}


// Netflow daily (all CEX) cho 1 asset từ query cex_netflow_daily_by_asset
// PARAM trên Dune: {{asset}} (text)
async function fetchExchangeNetflowDailyFromDune(asset = "BTC") {
    if (!DUNE_QUERY_ID_EXCHANGE_NETFLOW_BTC) return [];

    const base = normalizeToBaseAsset(asset);        // LINKUSDT -> LINK

    const rows = await getFromDune(
        DUNE_QUERY_ID_EXCHANGE_NETFLOW_BTC,
        { asset: base.toUpperCase() },              // {{asset}} = 'LINK'
        { maxAttempts: 20, delayMs: 1500 }          // netflow thường nhẹ hơn
    );

    return (rows || [])
        .map((r) => {
            const t = normalizeToMs(r.t || r.time || r.day);
            if (!t) return null;

            const sym =
                (r.asset || r.token_symbol || base).toString().toUpperCase();

            return {
                asset: sym,
                t,
                netflow: Number(r.netflow ?? r.value ?? 0),
                netflow_usd: Number(r.netflow_usd ?? 0),
                exchange: "all",
                source: "dune",
            };
        })
        .filter(Boolean);
}


// Whale flows cho 1 asset từ query cex_whale_exchange_flows_by_asset
// PARAM trên Dune: {{asset}} (text)
async function fetchWhaleExchangeFlowsFromDune(asset = "BTC") {
    if (!DUNE_QUERY_ID_WHALE_FLOWS_BTC) return [];

    const base = normalizeToBaseAsset(asset);

    const rows = await getFromDune(
        DUNE_QUERY_ID_WHALE_FLOWS_BTC,
        { asset: base.toUpperCase() },
        { maxAttempts: 40, delayMs: 2000 }          // cho whale nhiều thời gian hơn
    );

    return (rows || [])
        .map((r) => {
            const t = normalizeToMs(r.t || r.time || r.day);
            const amount = Number(r.amount ?? r.volume ?? r.value ?? 0);
            if (!t || !Number.isFinite(amount) || amount <= 0) return null;

            const sym =
                (r.asset || r.token_symbol || base).toString().toUpperCase();

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
                asset: sym,
                t,
                direction,
                exchange:
                    r.exchange || r.to_exchange || r.from_exchange || "all",
                amount,
                amount_usd: Number(r.amount_usd ?? 0),
                tx_count: Number.isFinite(txCount) ? txCount : null,
                avg_tx_size: Number.isFinite(avgTx) ? avgTx : null,
                source: "dune",
            };
        })
        .filter(Boolean);
}


// Tóm tắt whale flow theo 24h / 3d / 7d
function buildWhaleSummary(whaleRows = []) {
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;

    function sumPeriod(days) {
        const from = now - days * dayMs;
        const rows = whaleRows.filter((r) => r.t >= from);

        let deposit = 0;
        let withdraw = 0;
        let txCount = 0;

        for (const r of rows) {
            if (r.direction === "deposit") deposit += r.amount;
            if (r.direction === "withdraw") withdraw += r.amount;
            txCount += r.tx_count || 0;
        }

        return {
            deposit,
            withdraw,
            netflow: withdraw - deposit,
            tx_count: txCount,
        };
    }

    return {
        "24h": sumPeriod(1),
        "3d": sumPeriod(3),
        "7d": sumPeriod(7),
    };
}


async function fetchOnchainData(asset = "BTC") {
    try {
        return await fetchOnchainFromDuneCombined(asset);
    } catch (err) {
        console.error(
            "fetchOnchainData (Dune combined) error:",
            err.response?.data || err.message || err
        );
        return {
            exchange_netflow_daily: [],
            whale_exchange_flows: [],
            whale_summary: {},
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

// =============== Route phụ: /api/bybit/onchain ===============
// Hỗ trợ:
//   /api/bybit/onchain?asset=BTC
//   /api/bybit/onchain?asset=BTCUSDT
//   /api/bybit/onchain?symbol=LINKUSDT

// Hỗ trợ:
//   /api/bybit/onchain?asset=BTC
//   /api/bybit/onchain?asset=BTCUSDT
//   /api/bybit/onchain?symbol=LINKUSDT
router.get("/onchain", async (req, res) => {
    try {
        const rawInput = (
            req.query.asset ||
            req.query.symbol ||
            "BTC"
        ).toString().trim();

        // Không normalize sang base nữa, giữ nguyên giá trị client gửi lên
        const assetOrSymbol = rawInput || "BTC";

        const onchain = await fetchOnchainData(assetOrSymbol);

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
