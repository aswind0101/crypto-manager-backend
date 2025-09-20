// backend/routes/market.js
import express from "express";

const router = express.Router();

const VENUES = [
  { name: "binance.com", base: "https://api.binance.com" },
  { name: "binance.us",  base: "https://api.binance.us"  },
];

function fetchWithTimeout(url, ms = 4000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), ms);
  return fetch(url, { signal: controller.signal })
    .finally(() => clearTimeout(id));
}

/**
 * GET /api/market/detect-binance/:base?quotes=USDT,USDC,BUSD
 * Thử lần lượt {base}{quote} trên cả binance.com & binance.us.
 * Trả về: { ok: true, symbol: "BTCUSDT", venue: "binance.com" } nếu tìm thấy.
 */
router.get("/detect-binance/:base", async (req, res) => {
  try {
    const base = String(req.params.base || "").toUpperCase().trim();
    if (!base) return res.status(400).json({ ok: false, error: "Missing base symbol" });

    const quotes = String(req.query.quotes || "USDT,BUSD,USDC")
      .split(",")
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);

    for (const v of VENUES) {
      for (const q of quotes) {
        const symbol = `${base}${q}`;
        try {
          // Dùng exchangeInfo để kiểm tra cặp tồn tại
          const url = `${v.base}/api/v3/exchangeInfo?symbol=${symbol}`;
          const r = await fetchWithTimeout(url, 4500);
          if (r.ok) {
            const j = await r.json().catch(() => ({}));
            // Binance trả về {symbols:[{symbol:"BTCUSDT", status:"TRADING", ...}]}
            const s = Array.isArray(j?.symbols) ? j.symbols.find(x => x?.symbol === symbol) : null;
            if (s) {
              return res.json({ ok: true, symbol, venue: v.name });
            }
          }
        } catch (_) {
          // bỏ qua và thử tiếp
        }
      }
    }

    return res.json({ ok: false, symbol: null, venue: null });
  } catch (e) {
    console.error("detect-binance error:", e);
    return res.status(500).json({ ok: false, error: "Internal Server Error" });
  }
});

export default router;
