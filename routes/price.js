import express from "express";
import fetch from "node-fetch";
import NodeCache from "node-cache";
import pkg from "pg";
const { Pool } = pkg;

const router = express.Router();
const cache = new NodeCache(); // Dùng TTL riêng từng key

const isProduction = process.env.NODE_ENV === "production";
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: isProduction ? { rejectUnauthorized: false } : false,
});

// Hàm lấy danh sách coin từ database, có cache
async function getCoinListFromDatabase() {
    const COIN_LIST_CACHE_KEY = "coinList";

    const cached = cache.get(COIN_LIST_CACHE_KEY);
    if (cached) return cached;

    const result = await pool.query("SELECT id, symbol FROM coins");
    const coinList = result.rows;

    cache.set(COIN_LIST_CACHE_KEY, coinList, 3600); // TTL: 1 giờ
    return coinList;
}

// Hàm lấy giá theo ID từ CoinGecko
async function fetchCoinPricesFromGecko(coinIds = []) {
    const idsParam = coinIds.join(",");
    const res = await fetch(`https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${idsParam}`);
    if (!res.ok) throw new Error("Failed to fetch market data from CoinGecko");
    return await res.json(); // [{ id, current_price, ... }]
}

// Route: /api/price?symbols=BTC,NEAR
router.get("/", async (req, res) => {
    const symbolsParam = req.query.symbols;
    if (!symbolsParam) return res.status(400).json({ error: "Missing symbols" });

    const symbols = symbolsParam.split(",").map(s => s.trim().toUpperCase());
    const cacheKey = `price_${symbols.join(",")}`;

    try {
        // B1. Trả từ cache nếu có
        const cached = cache.get(cacheKey);
        if (cached) return res.json(cached);

        // B2. Lấy danh sách coin từ DB (có cache 1h)
        const coinList = await getCoinListFromDatabase();

        // B3. Map symbol -> CoinGecko ID
        const symbolToId = {};
        for (const symbol of symbols) {
            const match = coinList.find(c => c.symbol.toLowerCase() === symbol.toLowerCase());
            if (match) symbolToId[symbol] = match.id;
        }

        const validIds = Object.values(symbolToId);
        if (validIds.length === 0) {
            throw new Error("No valid CoinGecko IDs found");
        }

        // B4. Gọi CoinGecko lấy giá
        const marketData = await fetchCoinPricesFromGecko(validIds);

        // B5. Map lại symbol → price
        const priceMap = {};
        for (const [symbol, id] of Object.entries(symbolToId)) {
            const coin = marketData.find(m => m.id === id);
            if (coin) priceMap[symbol] = coin.current_price;
        }

        // B6. Lưu cache (TTL: 5 phút)
        cache.set(cacheKey, priceMap, 300);

        res.json(priceMap);

    } catch (err) {
        console.error("❌ Price fetch error:", err.message);
        res.status(500).json({ error: "Failed to fetch coin prices" });
    }
});

export default router;
