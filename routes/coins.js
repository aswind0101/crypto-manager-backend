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
        const { rows: coinRows } = await q(
            `SELECT id, symbol FROM crypto_assets WHERE UPPER(symbol)=UPPER($1)`,
            [symbol]
        );
        if (!coinRows.length) return res.status(404).json({ error: "Symbol not found" });
        const coin_id = coinRows[0].id;

        const { rows: rowsA } = await q(
            `SELECT overall_score, action, confidence, buy_zone_min, buy_zone_max,
              stop_loss, take_profit_1, take_profit_2, run_at, data
         FROM coin_analysis
        WHERE coin_id=$1
        ORDER BY run_at DESC
        LIMIT 1`,
            [coin_id]
        );
        if (!rowsA.length) {
            return res.json({ message: "No analysis yet. Run POST /api/coins/:symbol/run-analysis" });
        }
        const a = rowsA[0];
        const data = a.data || {};
        const reentry = Array.isArray(data.reentry_zone) ? data.reentry_zone.map(Number) : null;

        res.json({
            symbol: coinRows[0].symbol,
            overall_score: Number(a.overall_score),
            action: a.action,
            confidence: a.confidence,
            buy_zone: [
                a.buy_zone_min != null ? Number(a.buy_zone_min) : null,
                a.buy_zone_max != null ? Number(a.buy_zone_max) : null,
            ],
            reentry_zone: reentry,
            stop_loss: a.stop_loss != null ? Number(a.stop_loss) : null,
            take_profit: [
                a.take_profit_1 != null ? Number(a.take_profit_1) : null,
                a.take_profit_2 != null ? Number(a.take_profit_2) : null,
            ],
            run_at: a.run_at,
            atr: Number.isFinite(Number(data.atr)) ? Number(data.atr) : null
        });
    } catch (e) {
        console.error("get analyze error:", e.message);
        res.status(500).json({ error: "Internal Server Error" });
    }
});


// === Thêm vào cuối file ===

router.get("/:symbol/insights", async (req, res) => {
    try {
        const symbol = String(req.params.symbol || "").toUpperCase();
        const win = String(req.query.window || "48h").toLowerCase();
        const allowed = new Set(["24h", "48h", "7d", "30d", "all"]);
        const windowReq = allowed.has(win) ? win : "48h";

        const { rows: coinRows } = await q(
            `SELECT id FROM crypto_assets WHERE UPPER(symbol)=UPPER($1) LIMIT 1`,
            [symbol]
        );
        if (!coinRows.length) return res.status(404).json({ error: "Symbol not found" });
        const coinId = coinRows[0].id;

        const cond = (col) => (
            windowReq === "all" ? "TRUE" :
                windowReq === "24h" ? `${col} > NOW() - INTERVAL '24 hours'` :
                    windowReq === "48h" ? `${col} > NOW() - INTERVAL '48 hours'` :
                        windowReq === "7d" ? `${col} > NOW() - INTERVAL '7 days'` :
                            `${col} > NOW() - INTERVAL '30 days'`
        );

        const { rows: oc } = await q(
            `SELECT
         COALESCE(SUM(CASE WHEN direction='to_exchange'   THEN amount_usd ELSE 0 END),0)::float AS inflow_usd,
         COALESCE(SUM(CASE WHEN direction='from_exchange' THEN amount_usd ELSE 0 END),0)::float AS outflow_usd,
         COALESCE(SUM(CASE WHEN is_large THEN 1 ELSE 0 END), 0)::int AS large_count
       FROM onchain_transfers
       WHERE coin_id=$1 AND ${cond("block_time")}`, [coinId]
        );
        const inflow = oc[0]?.inflow_usd || 0;
        const outflow = oc[0]?.outflow_usd || 0;
        const netflow = outflow - inflow;

        const { rows: nw } = await q(
            `SELECT
         COALESCE(COUNT(*),0)::int AS count_window,
         COALESCE(AVG(sentiment_score),0)::float AS avg_sentiment
       FROM news_items
       WHERE coin_id=$1 AND ${cond("published_at")}`, [coinId]
        );

        res.json({
            symbol,
            window_used: windowReq,
            onchain: {
                inflow_usd: inflow,
                outflow_usd: outflow,
                netflow_usd: netflow,
                large_count: oc[0]?.large_count || 0
            },
            news: {
                count: nw[0]?.count_window || 0,
                avg_sentiment: nw[0]?.avg_sentiment || 0
            }
        });
    } catch (e) {
        console.error("coins/:symbol/insights error:", e);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

export default router;
