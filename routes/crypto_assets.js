// backend/routes/crypto_assets.js
import express from "express";
import { q } from "../utils/db.js";

const router = express.Router();

/**
 * POST /api/crypto-assets/register
 * Body: { symbol, name, chain, contract_address, decimals, coingecko_id, binance_symbol }
 * - Upsert vào crypto_assets (is_active = true)
 * - Trả về bản ghi đã insert/update
 */
router.post("/register", async (req, res) => {
  try {
    let {
      symbol, name, chain, contract_address,
      decimals, coingecko_id, binance_symbol
    } = req.body || {};

    // Validate cơ bản
    if (!symbol || !name) {
      return res.status(400).json({ error: "symbol và name là bắt buộc" });
    }
    symbol = symbol.toUpperCase();

    // Upsert
    const { rows } = await q(
      `INSERT INTO crypto_assets
         (symbol, name, chain, contract_address, decimals, coingecko_id, binance_symbol, is_active, created_at, updated_at)
       VALUES
         ($1,$2,$3,$4,$5,$6,$7, TRUE, NOW(), NOW())
       ON CONFLICT (symbol)
       DO UPDATE SET
         name = EXCLUDED.name,
         chain = EXCLUDED.chain,
         contract_address = EXCLUDED.contract_address,
         decimals = EXCLUDED.decimals,
         coingecko_id = EXCLUDED.coingecko_id,
         binance_symbol = EXCLUDED.binance_symbol,
         is_active = TRUE,
         updated_at = NOW()
       RETURNING id, symbol, name, chain, contract_address, decimals, coingecko_id, binance_symbol, is_active`,
      [symbol, name, chain || null, contract_address || null,
       decimals ?? null, coingecko_id || null, binance_symbol || null]
    );

    return res.json(rows[0]);
  } catch (e) {
    console.error("crypto-assets/register error:", e.message);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

export default router;
