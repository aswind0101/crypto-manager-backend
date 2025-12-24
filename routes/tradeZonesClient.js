// crypto-manager-backend/routes/tradeZonesClient.js
import express from "express";
import { generateTradeZonesFromClientData } from "../services/tradeZoneEngineClient.js";

const router = express.Router();

/**
 * POST /api/trade-zones-client
 * body: { symbol, klinesM15, klinesH4, receivedAt? }
 */
router.post("/", async (req, res) => {
  try {
    const symbol = (req.body?.symbol || "ETHUSDT").toString().trim().toUpperCase();
    const klinesM15 = req.body?.klinesM15;
    const klinesH4 = req.body?.klinesH4;
    const receivedAt = Number(req.body?.receivedAt || Date.now());

    const result = generateTradeZonesFromClientData({
      symbol,
      klinesM15,
      klinesH4,
      receivedAt,
    });

    res.json(result);
  } catch (err) {
    console.error("trade-zones-client error:", err.message || err);
    res.status(500).json({
      meta: { warnings: ["internal_error"] },
      tradeZones: [],
      error: err.message || "Internal Server Error",
    });
  }
});

export default router;
