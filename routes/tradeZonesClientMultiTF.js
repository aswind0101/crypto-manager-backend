// crypto-manager-backend/routes/tradeZonesClientMultiTF.js
import express from "express";
import { generateTradeZonesMultiTFFromClientData } from "../services/tradeZoneEngineClientMultiTF.js";

const router = express.Router();

/**
 * POST /api/trade-zones-client-multitf
 * body: { symbol, receivedAt?, klinesByTF: { M5,M15,H1,H4,D1 } }
 */
router.post("/", async (req, res) => {
  try {
    const symbol = (req.body?.symbol || "ETHUSDT").toString().trim().toUpperCase();
    const receivedAt = Number(req.body?.receivedAt || Date.now());
    const klinesByTF = req.body?.klinesByTF || {};

    const result = generateTradeZonesMultiTFFromClientData({
      symbol,
      klinesByTF,
      receivedAt,
    });

    res.json(result);
  } catch (err) {
    console.error("trade-zones-client-multitf error:", err.message || err);
    res.status(500).json({
      meta: { warnings: ["internal_error"] },
      tradeZones: [],
      error: err.message || "Internal Server Error",
    });
  }
});

export default router;
