import express from "express";
import fetch from "node-fetch";
import NodeCache from "node-cache";

const router = express.Router();
const cache = new NodeCache({ stdTTL: 300 }); // cache giá 5 phút
const COIN_LIST_KEY = "coinList";

// Hàm lấy giá coin
// ====== Hàm mới: Ưu tiên lấy giá từ Binance US, fallback sang CoinGecko ======
async function fetchCoinPrices(symbols) {
    const prices = {};
    const unresolvedSymbols = [];

    // 1. Ưu tiên gọi từ Binance US
    for (const symbol of symbols) {
        const binanceSymbol = symbol.toUpperCase() + "USDT";
        try {
            const res = await fetch(`https://api.binance.us/api/v3/ticker/price?symbol=${binanceSymbol}`);
            if (res.ok) {
                const data = await res.json();
                prices[symbol.toUpperCase()] = parseFloat(data.price);
            } else {
                unresolvedSymbols.push(symbol);
            }
        } catch (err) {
            console.warn(`⚠️ Binance API failed for ${symbol}:`, err.message);
            unresolvedSymbols.push(symbol);
        }
    }

    if (unresolvedSymbols.length === 0) return prices;

    // 2. Nếu vẫn còn coin chưa lấy được giá → fallback sang CoinGecko
    let coinList = cache.get(COIN_LIST_KEY);
    if (!coinList) {
        const res = await fetch("https://api.coingecko.com/api/v3/coins/list");
        if (!res.ok) throw new Error("Failed to fetch coin list");
        coinList = await res.json();
        cache.set(COIN_LIST_KEY, coinList, 3600);
    }

    const matchedIds = [];
    const symbolToIds = {};
    unresolvedSymbols.forEach(symbol => {
        const matches = coinList.filter(c => c.symbol.toLowerCase() === symbol.toLowerCase());
        if (matches.length > 0) {
            const ids = matches.map(m => m.id);
            matchedIds.push(...ids);
            symbolToIds[symbol.toUpperCase()] = ids;
        }
    });

    if (matchedIds.length > 0) {
        const idsParam = matchedIds.join(",");
        const res = await fetch(`https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${idsParam}`);
        if (res.ok) {
            const marketData = await res.json();
            for (const symbol of unresolvedSymbols) {
                const ids = symbolToIds[symbol.toUpperCase()];
                if (!ids || ids.length === 0) continue;

                const candidates = marketData.filter(c => ids.includes(c.id));
                if (candidates.length === 0) continue;

                const selected = candidates.reduce((a, b) => (a.market_cap || 0) > (b.market_cap || 0) ? a : b);
                prices[symbol.toUpperCase()] = selected.current_price;
            }
        }
    }

    return prices;
}


// Route: /api/price?symbols=BTC,NEAR
router.get("/", async (req, res) => {
    const symbolsParam = req.query.symbols;
    if (!symbolsParam) return res.status(400).json({ error: "Missing symbols" });

    const symbols = symbolsParam.split(",").map(s => s.trim().toUpperCase());
    const cacheKey = symbols.join(",");

    try {
        const cached = cache.get(cacheKey);
        if (cached) {
            return res.json(cached);
        }

        const prices = await fetchCoinPrices(symbols);
        cache.set(cacheKey, prices);
        res.json(prices);
    } catch (err) {
        console.error("❌ Price fetch error:", err.message);
        res.status(500).json({ error: "Failed to fetch coin prices" });
    }
});

export default router;
