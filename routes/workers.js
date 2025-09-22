// backend/routes/workers.js
import express from "express";
import { q } from "../utils/db.js";
import { fetchOhlcForCoin } from "../workers/price_worker.js";
import { runOnchainForSymbol } from "../workers/onchain_worker.js";
import { runNewsForSymbol } from "../workers/news_worker.js";

const router = express.Router();

// helper: tìm coin đang active theo symbol
async function getCoinBySymbol(symbol) {
    const { rows } = await q(
        `SELECT id, symbol, coingecko_id, binance_symbol, chain, contract_address, decimals
     FROM crypto_assets
     WHERE is_active=true AND UPPER(symbol)=UPPER($1)`,
        [symbol]
    );
    return rows[0] || null;
}

/**
 * POST /api/workers/refresh-price/:symbol
 * - Nạp OHLC cho 1 coin
 */
router.post("/refresh-price/:symbol", async (req, res) => {
    try {
        const coin = await getCoinBySymbol(req.params.symbol);
        if (!coin) return res.status(404).json({ error: "Symbol not found in crypto_assets" });

        const n = await fetchOhlcForCoin(coin);
        return res.json({ status: "ok", priceRows: n });
    } catch (e) {
        console.error("refresh-price error:", e.message);
        return res.status(500).json({ error: "Internal Server Error" });
    }
});

/**
 * POST /api/workers/refresh-all/:symbol
 * - Nạp giá + on-chain + news cho 1 coin (best effort)
 */
router.post("/refresh-all/:symbol", async (req, res) => {
    try {
        const coin = await getCoinBySymbol(req.params.symbol);
        if (!coin) return res.status(404).json({ error: "Symbol not found in crypto_assets" });

        let priceRows = 0, onchainRows = 0, newsRows = 0;

        // 1) Price
        try { priceRows = await fetchOhlcForCoin(coin); } catch (e) { console.warn("refresh-all price:", e.message); }
        // 2) On-chain
        try {
            const ONCHAIN_TIMEOUT_MS = Number(process.env.ONCHAIN_TIMEOUT_MS || 25000);
            const p = runOnchainForSymbol(coin.symbol);
            onchainRows = await Promise.race([
                p,
                new Promise((resolve) => setTimeout(() => resolve(-1), ONCHAIN_TIMEOUT_MS)) // -1 = timeout
            ]);
        } catch (e) { console.warn("onchain:", e.message); }
        // 3) News
        try { newsRows = await runNewsForSymbol(coin.symbol); } catch (e) { console.warn("refresh-all news:", e.message); }

        return res.json({ status: "ok", priceRows, onchainRows, newsRows });
    } catch (e) {
        console.error("refresh-all error:", e.message);
        return res.status(500).json({ error: "Internal Server Error" });
    }
});

// DEBUG: onchain check

const RPC_MAP = {
    ETHEREUM: process.env.ETH_RPC_URL || "https://cloudflare-eth.com",
    BSC: process.env.BSC_RPC_URL || "https://bsc-dataseed.binance.org",
    POLYGON: process.env.POLYGON_RPC_URL || "https://polygon-rpc.com",
    ARBITRUM: process.env.ARBITRUM_RPC_URL || "https://arb1.arbitrum.io/rpc",
    OPTIMISM: process.env.OPTIMISM_RPC_URL || "https://mainnet.optimism.io",
    BASE: process.env.BASE_RPC_URL || "https://mainnet.base.org",
    AVALANCHE: process.env.AVAX_RPC_URL || "https://api.avax.network/ext/bc/C/rpc",
};

router.get("/debug/onchain/:symbol", async (req, res) => {
    try {
        const sym = String(req.params.symbol || "").toUpperCase();
        const { rows } = await q(
            `SELECT id, symbol, chain, contract_address, decimals
       FROM crypto_assets WHERE UPPER(symbol)=UPPER($1) LIMIT 1`, [sym]
        );
        if (!rows.length) return res.status(404).json({ ok: false, error: "symbol_not_found" });

        const c = rows[0];
        const chainKey = (c.chain || "").toUpperCase();
        const rpcUrl = RPC_MAP[chainKey] || null;

        const reasons = [];
        if (!rpcUrl) reasons.push(`unsupported_chain:${c.chain || "null"}`);
        if (!c.contract_address) reasons.push("missing_contract_address");
        if (!Number.isFinite(Number(c.decimals))) reasons.push("missing_decimals_(default_18_used)");

        let inserted = 0;
        if (reasons.length === 0) {
            try {
                inserted = await runOnchainForSymbol(sym);
            } catch (e) {
                reasons.push(`run_error:${e.message}`);
            }
        }

        const { rows: cnt } = await q(
            `SELECT COUNT(*)::int AS n FROM onchain_transfers
       WHERE coin_id=$1 AND block_time > NOW() - INTERVAL '24 hours'`,
            [c.id]
        );
        const { rows: last } = await q(
            `SELECT tx_hash, amount_token, amount_usd, direction, exchange_name, block_time
       FROM onchain_transfers
       WHERE coin_id=$1 ORDER BY block_time DESC LIMIT 5`,
            [c.id]
        );

        res.json({
            ok: true,
            coin: c,
            can_scan: reasons.length === 0,
            reasons,
            rpc_in_use: rpcUrl,
            inserted_now: inserted,
            count_24h: cnt[0]?.n || 0,
            last_5: last
        });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

// POST /api/workers/refresh-onchain/:symbol
router.post("/refresh-onchain/:symbol", async (req, res) => {
    try {
        const sym = String(req.params.symbol || "").toUpperCase();

        // kiểm tra coin tồn tại và đang active
        const { rows } = await q(
            `SELECT id FROM crypto_assets WHERE is_active=true AND UPPER(symbol)=UPPER($1) LIMIT 1`,
            [sym]
        );
        if (!rows.length) {
            return res.status(404).json({ error: "Symbol not found in crypto_assets" });
        }

        // chạy on-chain đầy đủ, không bị race với timeout của refresh-all
        const inserted = await runOnchainForSymbol(sym);
        return res.json({ status: "ok", onchainRows: inserted });
    } catch (e) {
        console.error("refresh-onchain error:", e.message);
        return res.status(500).json({ error: "Internal Server Error" });
    }
});

// GET /api/workers/debug/window/:symbol
router.get("/debug/window/:symbol", async (req, res) => {
  try {
    const sym = String(req.params.symbol || "").toUpperCase();
    const { rows } = await q(
      `SELECT id, symbol, chain, contract_address, decimals
       FROM crypto_assets WHERE UPPER(symbol)=UPPER($1) LIMIT 1`, [sym]
    );
    if (!rows.length) return res.status(404).json({ ok:false, error:"symbol_not_found" });

    const chain = (rows[0].chain || "").toUpperCase();
    const RPC_MAP = {
      ETHEREUM: process.env.ETH_RPC_URL || "https://cloudflare-eth.com",
      BSC: process.env.BSC_RPC_URL || "https://bsc-dataseed.binance.org",
      POLYGON: process.env.POLYGON_RPC_URL || "https://polygon-rpc.com",
      ARBITRUM: process.env.ARBITRUM_RPC_URL || "https://arb1.arbitrum.io/rpc",
      OPTIMISM: process.env.OPTIMISM_RPC_URL || "https://mainnet.optimism.io",
      BASE: process.env.BASE_RPC_URL || "https://mainnet.base.org",
      AVALANCHE: process.env.AVAX_RPC_URL || "https://api.avax.network/ext/bc/C/rpc",
    };
    const rpcUrl = RPC_MAP[chain] || null;
    if (!rpcUrl) return res.json({ ok:true, can_scan:false, reason:"unsupported_chain", chain });

    // Lấy latest block và tính cửa sổ giống worker
    async function rpcCall(method, params = [], timeoutMs = 8000) {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const r = await fetch(rpcUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
          signal: ctrl.signal,
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok || j.error) throw new Error(j?.error?.message || `HTTP ${r.status}`);
        return j.result;
      } finally { clearTimeout(t); }
    }

    const latestHex = await rpcCall("eth_blockNumber", []);
    const latest = Number(BigInt(latestHex));
    const windowHours = Number(process.env.ONCHAIN_WINDOW_HOURS || 12);

    // Ước lượng back giống trong worker (xấp xỉ)
    const probe = Math.max(latest - 5000, 1);
    const [bLatest, bProbe] = await Promise.all([
      rpcCall("eth_getBlockByNumber", [latestHex, false]),
      rpcCall("eth_getBlockByNumber", ["0x" + probe.toString(16), false]),
    ]);
    const tsLatest = Number(BigInt(bLatest.timestamp));
    const tsProbe  = Number(BigInt(bProbe.timestamp));
    const secsPerBlock = Math.max(1, (tsLatest - tsProbe) / (latest - probe));

    let back = Math.floor((windowHours * 3600) / secsPerBlock);
    back = Math.min(Math.max(back, 1500), 120000);

    const fromBlock = Math.max(1, latest - back);
    const toBlock   = latest;

    return res.json({
      ok: true,
      symbol: sym,
      chain,
      rpc_in_use: rpcUrl,
      windowHours,
      latest,
      secsPerBlock,
      back,
      fromBlock,
      toBlock
    });
  } catch (e) {
    console.error("debug/window error:", e.message);
    return res.status(500).json({ ok:false, error:"internal_error" });
  }
});

// GET /api/workers/debug/raw-logs/:symbol
router.get("/debug/raw-logs/:symbol", async (req, res) => {
  try {
    const sym = String(req.params.symbol || "").toUpperCase();
    const { rows } = await q(
      `SELECT id, symbol, chain, contract_address, decimals
       FROM crypto_assets WHERE UPPER(symbol)=UPPER($1) LIMIT 1`, [sym]
    );
    if (!rows.length) return res.status(404).json({ ok:false, error:"symbol_not_found" });
    const coin = rows[0];
    if (!coin.contract_address) return res.json({ ok:true, can_scan:false, reason:"missing_contract" });

    const chain = (coin.chain || "").toUpperCase();
    const RPC_MAP = {
      ETHEREUM: process.env.ETH_RPC_URL || "https://cloudflare-eth.com",
      BSC: process.env.BSC_RPC_URL || "https://bsc-dataseed.binance.org",
      POLYGON: process.env.POLYGON_RPC_URL || "https://polygon-rpc.com",
      ARBITRUM: process.env.ARBITRUM_RPC_URL || "https://arb1.arbitrum.io/rpc",
      OPTIMISM: process.env.OPTIMISM_RPC_URL || "https://mainnet.optimism.io",
      BASE: process.env.BASE_RPC_URL || "https://mainnet.base.org",
      AVALANCHE: process.env.AVAX_RPC_URL || "https://api.avax.network/ext/bc/C/rpc",
    };
    const rpcUrl = RPC_MAP[chain] || null;
    if (!rpcUrl) return res.json({ ok:true, can_scan:false, reason:"unsupported_chain", chain });

    async function rpcCall(method, params = [], timeoutMs = 15000) {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const r = await fetch(rpcUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
          signal: ctrl.signal,
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok || j.error) throw new Error(j?.error?.message || `HTTP ${r.status}`);
        return j.result;
      } finally { clearTimeout(t); }
    }

    const latestHex = await rpcCall("eth_blockNumber", []);
    const latest = Number(BigInt(latestHex));
    const fromBlock = Math.max(1, latest - 2000);
    const toBlock   = latest;

    const params = [{
      fromBlock: "0x" + fromBlock.toString(16),
      toBlock:   "0x" + toBlock.toString(16),
      address:   coin.contract_address, // lọc theo token contract
      topics: ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"] // Transfer(address,address,uint256)
    }];

    let logs = [];
    try {
      const part = await rpcCall("eth_getLogs", params, 20000);
      logs = Array.isArray(part) ? part : [];
    } catch (e) {
      return res.json({ ok:false, rpc_error: e.message, rpc_in_use: rpcUrl, fromBlock, toBlock });
    }

    return res.json({
      ok: true,
      rpc_in_use: rpcUrl,
      fromBlock,
      toBlock,
      count: logs.length,
      sample: logs.slice(0, 3) // vài log đầu để xem cấu trúc
    });
  } catch (e) {
    console.error("debug/raw-logs error:", e.message);
    return res.status(500).json({ ok:false, error:"internal_error" });
  }
});

export default router;
