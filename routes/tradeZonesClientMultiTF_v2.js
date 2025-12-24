// crypto-manager-backend/routes/tradeZonesClientMultiTF_v2.js
import express from "express";
import { runSpecPipelineFromClientRaw_v1 } from "../services/tradeZoneEngineClientMultiTF_v2.js";

const router = express.Router();

/**
 * POST /api/trade-zones-client-multitf-v2
 * body: {
 *   symbol,
 *   receivedAt?,
 *   raw?: { market?:..., fetched_at_ts, server_time_ts, request_ids:[] },
 *   klinesByTF: { "5":[], "15":[], "60":[], "240":[], "D":[] }
 * }
 */
router.post("/", async (req, res) => {
  try {
    const symbol = (req.body?.symbol || "ETHUSDT").toString().trim().toUpperCase();
    const receivedAt = Number(req.body?.receivedAt || Date.now());
    const raw = req.body?.raw || {};
    const klinesByTF = req.body?.klinesByTF || {};

    const result = runSpecPipelineFromClientRaw_v1({
      symbol,
      receivedAt,
      raw,
      klinesByTF,
    });

    res.json(result);
  } catch (err) {
    console.error("trade-zones-client-multitf-v2 error:", err?.message || err);
    res.status(500).json({
      meta: { warnings: ["internal_error"] },
      tradeZones: [],
      error: err?.message || "Internal Server Error",
    });
  }
});

export default router;
