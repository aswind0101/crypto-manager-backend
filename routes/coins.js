// backend/routes/coins.js
import express from "express";
import { q } from "../utils/db.js";
import { analyzeCoin } from "../services/analyzer.js";

const router = express.Router();

// chạy phân tích thủ công
router.post("/:symbol/run-analysis", async (req, res) => {
    const { symbol } = req.params;
    try {
        const result = await analyzeCoin(symbol);
        res.json(result);
    } catch (e) {
        console.error("run-analysis error:", e.message);
        res.status(400).json({ error: e.message });
    }
});

// lấy kết quả phân tích mới nhất
router.get("/:symbol/analyze", async (req, res) => {
    const { symbol } = req.params;
    try {
        const { rows: coinRows } = await q(`SELECT id, symbol FROM crypto_assets WHERE UPPER(symbol)=UPPER($1)`, [symbol]);
        if (!coinRows.length) return res.status(404).json({ error: "Symbol not found" });
        const coin_id = coinRows[0].id;

        const { rows: rowsA } = await q(
            `SELECT overall_score, action, confidence, buy_zone_min, buy_zone_max, stop_loss, take_profit_1, take_profit_2, run_at
       FROM coin_analysis WHERE coin_id=$1 ORDER BY run_at DESC LIMIT 1`,
            [coin_id]
        );
        if (!rowsA.length) return res.json({ message: "No analysis yet. Run POST /api/coins/:symbol/run-analysis" });
        const a = rowsA[0];

        res.json({
            symbol: coinRows[0].symbol,
            overall_score: Number(a.overall_score),
            action: a.action,
            confidence: a.confidence,
            buy_zone: [Number(a.buy_zone_min), Number(a.buy_zone_max)],
            stop_loss: Number(a.stop_loss),
            take_profit: [Number(a.take_profit_1), Number(a.take_profit_2)],
            run_at: a.run_at
        });
    } catch (e) {
        console.error("get analyze error:", e.message);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

export default router;
