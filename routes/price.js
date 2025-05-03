import express from "express";
import fetch from "node-fetch";
import NodeCache from "node-cache";
import dotenv from 'dotenv';
dotenv.config();


const router = express.Router();
const cache = new NodeCache({ stdTTL: 300 }); // cache giá 5 phút
const COIN_LIST_KEY = "coinList";

// Hàm lấy giá coin
// ====== Hàm mới: Ưu tiên lấy giá từ Binance US, fallback sang CoinGecko ======
// Hàm lấy giá coin (ưu tiên: Binance US -> CryptoCompare -> CoinGecko)
async function fetchCoinPrices(symbols) {
    const prices = {};
    const unresolvedSymbols = [];

    // 1️⃣ Binance US
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

    // 2️⃣ CryptoCompare (nếu vẫn còn unresolved)
    const stillUnresolved = [];
    if (unresolvedSymbols.length > 0) {
        const apiKey = process.env.CRYPTOCOMPARE_API_KEY;
        for (const symbol of unresolvedSymbols) {
            try {
                const res = await fetch(`https://min-api.cryptocompare.com/data/price?fsym=${symbol.toUpperCase()}&tsyms=USD&api_key=${apiKey}`);
                if (res.ok) {
                    const data = await res.json();
                    if (data.USD) {
                        prices[symbol.toUpperCase()] = parseFloat(data.USD);
                    } else {
                        stillUnresolved.push(symbol);
                    }
                } else {
                    stillUnresolved.push(symbol);
                }
            } catch (err) {
                console.warn(`⚠️ CryptoCompare API failed for ${symbol}:`, err.message);
                stillUnresolved.push(symbol);
            }
        }
    }

    // 3️⃣ CoinGecko fallback (nếu vẫn còn unresolved)
    if (stillUnresolved.length > 0) {
        let coinList = cache.get(COIN_LIST_KEY);
        if (!coinList) {
            const res = await fetch("https://api.coingecko.com/api/v3/coins/list");
            if (res.ok) {
                coinList = await res.json();
                cache.set(COIN_LIST_KEY, coinList, 3600);
            } else {
                console.warn("⚠️ CoinGecko fetch coin list failed");
                return prices;
            }
        }

        const matchedIds = [];
        const symbolToIds = {};
        stillUnresolved.forEach(symbol => {
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
                for (const symbol of stillUnresolved) {
                    const ids = symbolToIds[symbol.toUpperCase()];
                    if (!ids || ids.length === 0) continue;

                    const candidates = marketData.filter(c => ids.includes(c.id));
                    if (candidates.length === 0) continue;

                    const selected = candidates.reduce((a, b) =>
                        (a.market_cap || 0) > (b.market_cap || 0) ? a : b
                    );
                    prices[symbol.toUpperCase()] = selected.current_price;
                }
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
