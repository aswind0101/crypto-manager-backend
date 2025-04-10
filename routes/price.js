import express from "express";
import fetch from "node-fetch";
import NodeCache from "node-cache";

const router = express.Router();
const cache = new NodeCache({ stdTTL: 300 }); // cache giá 5 phút
const COIN_LIST_KEY = "coinList";

// Hàm lấy giá coin
async function fetchCoinPrices(symbols) {
    // 1. Lấy coin list từ cache hoặc từ API
    let coinList = cache.get(COIN_LIST_KEY);
    if (!coinList) {
        const res = await fetch("https://api.coingecko.com/api/v3/coins/list");
        if (!res.ok) throw new Error("Failed to fetch coin list");
        coinList = await res.json();
        cache.set(COIN_LIST_KEY, coinList, 3600); // cache 1h
    }

    // 2. Tìm tất cả các ID khớp với symbol (không chọn luôn)
    const matchedIds = [];
    const symbolToIds = {};
    symbols.forEach(symbol => {
        const matches = coinList.filter(c => c.symbol.toLowerCase() === symbol.toLowerCase());
        if (matches.length > 0) {
            const ids = matches.map(m => m.id);
            matchedIds.push(...ids);
            symbolToIds[symbol.toUpperCase()] = ids;
        }
    });

    if (matchedIds.length === 0) throw new Error("No valid CoinGecko IDs");

    // 3. Gọi market data cho toàn bộ ID tìm được
    const idsParam = matchedIds.join(",");
    const res = await fetch(`https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${idsParam}`);
    if (!res.ok) throw new Error("Failed to fetch market data");
    const marketData = await res.json(); // array

    // 4. Chọn coin tốt nhất cho mỗi symbol theo market cap
    const priceMap = {};
    for (const symbol of symbols) {
        const ids = symbolToIds[symbol.toUpperCase()];
        if (!ids || ids.length === 0) continue;

        const candidates = marketData.filter(c => ids.includes(c.id));
        if (candidates.length === 0) continue;

        // Chọn coin có market_cap lớn nhất
        const selected = candidates.reduce((a, b) =>
            (a.market_cap || 0) > (b.market_cap || 0) ? a : b
        );

        priceMap[symbol.toUpperCase()] = selected.current_price;
    }

    return priceMap;
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
