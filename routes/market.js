// backend/routes/market.js
import express from "express";

const router = express.Router();

const VENUES = [
  { name: "binance.com", base: "https://api.binance.com" },
  { name: "binance.us",  base: "https://api.binance.us"  },
];

function fetchWithTimeout(url, ms = 4500) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), ms);
  return fetch(url, { signal: controller.signal, headers: { "accept": "application/json" } })
    .finally(() => clearTimeout(id));
}

/**
 * GET /api/market/detect-binance/:base?quotes=USDT,USDC,BUSD,TUSD
 * - Thử lần lượt {base}{quote} trên cả binance.com & binance.us
 * - Dùng endpoint nhẹ: /api/v3/ticker/price (ưu tiên), nếu fail thử /api/v3/exchangeInfo
 * Trả về:
 *   { ok: true, symbol: "ADAUSDT", venue: "binance.com" }
 *   hoặc { ok: false, symbol: null, venue: null, guessed: "ADAUSDT" }
 */
router.get("/detect-binance/:base", async (req, res) => {
  try {
    const base = String(req.params.base || "").toUpperCase().trim();
    if (!base) return res.status(400).json({ ok: false, error: "Missing base symbol" });

    const quotes = String(req.query.quotes || "USDT,USDC,BUSD,TUSD")
      .split(",")
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);

    for (const v of VENUES) {
      for (const q of quotes) {
        const symbol = `${base}${q}`;
        // 1) thử ticker/price (nhẹ, 200 => tồn tại)
        try {
          const r = await fetchWithTimeout(`${v.base}/api/v3/ticker/price?symbol=${symbol}`, 4500);
          if (r.ok) {
            const j = await r.json().catch(() => ({}));
            if (j?.symbol === symbol || j?.price) {
              return res.json({ ok: true, symbol, venue: v.name });
            }
          }
        } catch (_) {}

        // 2) thử exchangeInfo
        try {
          const r2 = await fetchWithTimeout(`${v.base}/api/v3/exchangeInfo?symbol=${symbol}`, 4500);
          if (r2.ok) {
            const j2 = await r2.json().catch(() => ({}));
            const s = Array.isArray(j2?.symbols) ? j2.symbols.find(x => x?.symbol === symbol) : null;
            if (s) return res.json({ ok: true, symbol, venue: v.name });
          }
        } catch (_) {}
      }
    }

    // Không tìm được: trả luôn bản đoán {base}USDT để FE có thể autofill nếu muốn
    return res.json({ ok: false, symbol: null, venue: null, guessed: `${base}USDT` });
  } catch (e) {
    console.error("detect-binance error:", e);
    return res.status(500).json({ ok: false, error: "Internal Server Error" });
  }
});

export default router;
