// crypto-manager-backend/routes/tradeZones.js
import express from "express";
import { generateTradeZonesForSymbol } from "../services/tradeZoneEngine.js";

const router = express.Router();

// GET /api/trade-zones?symbol=ETHUSDT
router.get("/", async (req, res) => {
  try {
    const symbol = (req.query.symbol || "ETHUSDT").toString().trim().toUpperCase();
    const result = await generateTradeZonesForSymbol(symbol);
    res.json(result);
  } catch (err) {
    console.error("trade-zones error:", err.message || err);
    res.status(500).json({
      meta: { warnings: ["internal_error"] },
      tradeZones: [],
      error: err.message || "Internal Server Error",
    });
  }
});

export default router;
