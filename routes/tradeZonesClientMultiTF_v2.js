// crypto-manager-backend/routes/tradeZonesClientMultiTF_v2.js
import express from "express";
import { generateTradeZonesMultiTFFromClientData_v2 } from "../services/tradeZoneEngineClientMultiTF_v2.js";

const router = express.Router();

/**
 * POST /api/trade-zones-client-multitf-v2
 * body: { symbol, receivedAt?, klinesByTF: { M5,M15,H1,H4,D1 } }
 */
router.post("/", async (req, res) => {
  try {
    const symbol = (req.body?.symbol || "ETHUSDT").toString().trim().toUpperCase();
    const receivedAt = Number(req.body?.receivedAt || Date.now());
    const klinesByTF = req.body?.klinesByTF || {};

    const result = generateTradeZonesMultiTFFromClientData_v2({
      symbol,
      klinesByTF,
      receivedAt,
    });

    res.json(result);
  } catch (err) {
    console.error("trade-zones-client-multitf-v2 error:", err.message || err);
    res.status(500).json({
      meta: { warnings: ["internal_error"] },
      tradeZones: [],
      error: err.message || "Internal Server Error",
    });
  }
});

export default router;
