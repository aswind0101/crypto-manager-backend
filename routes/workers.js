// backend/routes/workers.js
import express from "express";
import { q } from "../utils/db.js";
import { fetchOhlcForCoin } from "../workers/price_worker.js";
import { runOnchainForSymbol } from "../workers/onchain_worker.js";
import { runNewsForSymbol } from "../workers/news_worker.js";

const router = express.Router();

// helper: tìm coin đang active theo symbol
async function getCoinBySymbol(symbol) {
    const { rows } = await q(
        `SELECT id, symbol, coingecko_id, binance_symbol, chain, contract_address, decimals
     FROM crypto_assets
     WHERE is_active=true AND UPPER(symbol)=UPPER($1)`,
        [symbol]
    );
    return rows[0] || null;
}

/**
 * POST /api/workers/refresh-price/:symbol
 * - Nạp OHLC cho 1 coin
 */
router.post("/refresh-price/:symbol", async (req, res) => {
    try {
        const coin = await getCoinBySymbol(req.params.symbol);
        if (!coin) return res.status(404).json({ error: "Symbol not found in crypto_assets" });

        const n = await fetchOhlcForCoin(coin);
        return res.json({ status: "ok", priceRows: n });
    } catch (e) {
        console.error("refresh-price error:", e.message);
        return res.status(500).json({ error: "Internal Server Error" });
    }
});

/**
 * POST /api/workers/refresh-all/:symbol
 * - Nạp giá + on-chain + news cho 1 coin (best effort)
 */
router.post("/refresh-all/:symbol", async (req, res) => {
    try {
        const coin = await getCoinBySymbol(req.params.symbol);
        if (!coin) return res.status(404).json({ error: "Symbol not found in crypto_assets" });

        let priceRows = 0, onchainRows = 0, newsRows = 0;

        // 1) Price
        try { priceRows = await fetchOhlcForCoin(coin); } catch (e) { console.warn("refresh-all price:", e.message); }
        // 2) On-chain
        try {
            const ONCHAIN_TIMEOUT_MS = Number(process.env.ONCHAIN_TIMEOUT_MS || 25000);
            const p = runOnchainForSymbol(coin.symbol);
            onchainRows = await Promise.race([
                p,
                new Promise((resolve) => setTimeout(() => resolve(-1), ONCHAIN_TIMEOUT_MS)) // -1 = timeout
            ]);
        } catch (e) { console.warn("onchain:", e.message); }
        // 3) News
        try { newsRows = await runNewsForSymbol(coin.symbol); } catch (e) { console.warn("refresh-all news:", e.message); }

        return res.json({ status: "ok", priceRows, onchainRows, newsRows });
    } catch (e) {
        console.error("refresh-all error:", e.message);
        return res.status(500).json({ error: "Internal Server Error" });
    }
});

export default router;
