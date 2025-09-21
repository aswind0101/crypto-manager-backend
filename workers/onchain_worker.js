// backend/workers/onchain_worker.js
// FREE on-chain via public JSON-RPC (no API key).
// - Hỗ trợ EVM chains: Ethereum, BSC, Polygon, Arbitrum, Optimism, Base, Avalanche C.
// - Đọc ERC-20 Transfer logs (khoảng thời gian cấu hình, mặc định 12h) -> onchain_transfers
// - Nếu thiếu decimals => mặc định 18; nếu chưa có giá 15m => amount_usd=0

import { q } from "../utils/db.js";

const LARGE_USD = Number(process.env.ONCHAIN_LARGE_USD || 100000);

// Cho phép override RPC qua .env, nếu không có thì dùng public endpoints.
const RPC = {
  ETHEREUM: process.env.ETH_RPC_URL     || "https://cloudflare-eth.com",
  BSC:      process.env.BSC_RPC_URL     || "https://bsc-dataseed.binance.org",
  POLYGON:  process.env.POLYGON_RPC_URL || "https://polygon-rpc.com",
  ARBITRUM: process.env.ARBITRUM_RPC_URL|| "https://arb1.arbitrum.io/rpc",
  OPTIMISM: process.env.OPTIMISM_RPC_URL|| "https://mainnet.optimism.io",
  BASE:     process.env.BASE_RPC_URL    || "https://mainnet.base.org",
  AVALANCHE:process.env.AVAX_RPC_URL    || "https://api.avax.network/ext/bc/C/rpc",
};

function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

// ===== DB helpers =====
async function latestPriceUSD(coin_id){
  const { rows } = await q(
    `SELECT close FROM price_ohlc
     WHERE coin_id=$1 AND timeframe='15m'
     ORDER BY close_time DESC LIMIT 1`, [coin_id]
  );
  return rows[0]?.close ? Number(rows[0].close) : null;
}

async function loadExchangeMap(chain){
  const { rows } = await q(
    `SELECT address, name, is_deposit
       FROM exchange_addresses
      WHERE is_active=true AND UPPER(chain)=UPPER($1)`,
    [chain]
  );
  const m = new Map();
  for (const r of rows) m.set((r.address || "").toLowerCase(), { name: r.name, is_deposit: r.is_deposit });
  return m;
}

function directionAndName(from, to, exchangeMap){
  const f = exchangeMap.get((from||"").toLowerCase());
  const t = exchangeMap.get((to  ||"").toLowerCase());
  if (t) return { direction: "to_exchange", exchange_name: t.name };
  if (f) return { direction: "from_exchange", exchange_name: f.name };
  return { direction: "unknown", exchange_name: null };
}

async function insertTransfer(row){
  await q(
    `INSERT INTO onchain_transfers
       (coin_id, chain, tx_hash, from_address, to_address, amount_token, amount_usd,
        block_number, block_time, direction, exchange_name, is_large, source)
     VALUES
       ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     ON CONFLICT DO NOTHING`,
    [
      row.coin_id, row.chain, row.tx_hash, row.from_address, row.to_address,
      row.amount_token, row.amount_usd, row.block_number, row.block_time,
      row.direction, row.exchange_name, row.is_large, row.source
    ]
  );
}

// ===== RPC helpers =====
let rpcId = 1;
async function rpcCall(rpcUrl, method, params = [], timeoutMs = 8000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method, params }),
      signal: ctrl.signal,
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || j.error) {
      const msg = j?.error?.message || `HTTP ${res.status}`;
      throw new Error(`${method} failed: ${msg}`);
    }
    return j.result;
  } finally { clearTimeout(t); }
}
const hexToNumber = (hex) => Number(BigInt(hex));
const hexToBigInt  = (hex) => BigInt(hex);
const topicToAddress = (topic) => "0x" + String(topic).slice(-40);

// Ước lượng blocks cần lùi theo số giờ cấu hình (default 12h)
async function estimateBlocksBack(rpcUrl) {
  const windowHours = Number(process.env.ONCHAIN_WINDOW_HOURS || 12);
  const latestHex = await rpcCall(rpcUrl, "eth_blockNumber", []);
  const latest = hexToNumber(latestHex);

  // sample để tính seconds/block
  const probe = Math.max(latest - 5000, 1);
  const [bLatest, bProbe] = await Promise.all([
    rpcCall(rpcUrl, "eth_getBlockByNumber", [latestHex, false]),
    rpcCall(rpcUrl, "eth_getBlockByNumber", ["0x" + probe.toString(16), false]),
  ]);
  const tsLatest = hexToNumber(bLatest.timestamp);
  const tsProbe  = hexToNumber(bProbe.timestamp);
  const secsPerBlock = Math.max(1, (tsLatest - tsProbe) / (latest - probe));

  let back = Math.floor((windowHours * 3600) / secsPerBlock);
  back = Math.min(Math.max(back, 1500), 120000); // clamp
  return { latest, back };
}

// Lấy logs theo "adaptive chunk" để né limit: thu nhỏ range khi bị từ chối
async function getTransferLogsInRange(rpcUrl, address, fromBlock, toBlock, initChunk = 4000) {
  const MIN_CHUNK = 300;
  let chunk = initChunk;
  const logs = [];
  let start = fromBlock;

  while (start <= toBlock) {
    const end = Math.min(start + chunk - 1, toBlock);
    const params = [{
      fromBlock: "0x" + start.toString(16),
      toBlock:   "0x" + end.toString(16),
      address,
      topics: ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"] // Transfer(address,address,uint256)
    }];

    try {
      const part = await rpcCall(rpcUrl, "eth_getLogs", params, 15000);
      logs.push(...part);
      start = end + 1;
      await sleep(250); // dịu tải
    } catch (e) {
      const msg = (e.message || "").toLowerCase();
      const isLimit = msg.includes("limit") || msg.includes("exceed") || msg.includes("more than") ||
                      msg.includes("server error") || msg.includes("response size");
      const isRate  = msg.includes("rate") || msg.includes("too many") || msg.includes("timeout");

      if ((isLimit || isRate) && chunk > MIN_CHUNK) {
        chunk = Math.max(MIN_CHUNK, Math.floor(chunk / 2));
        console.warn(`eth_getLogs limited → shrink chunk to ${chunk} blocks`);
        await sleep(700);
        continue;
      }
      console.warn(`eth_getLogs ${start}-${end} failed: ${e.message} → skip this slice`);
      start = end + 1;
      await sleep(300);
    }
  }
  return logs;
}

// ===== main fetcher via RPC =====
async function fetchFromRPC(coin) {
  const chainKey = (coin.chain || "").toUpperCase();
  const rpcUrl = RPC[chainKey];
  if (!rpcUrl) return 0;                 // không hỗ trợ chain
  if (!coin.contract_address) return 0;  // ERC-20 bắt buộc có contract

  const exMap = await loadExchangeMap(coin.chain || "");
  const price = await latestPriceUSD(coin.id);
  const decimals = Number.isFinite(Number(coin.decimals)) ? Number(coin.decimals) : 18;

  const { latest, back } = await estimateBlocksBack(rpcUrl);
  const fromBlock = Math.max(1, latest - back);
  const toBlock   = latest;

  const logs = await getTransferLogsInRange(rpcUrl, coin.contract_address, fromBlock, toBlock, 4000);

  // Cache timestamp theo block để giảm RPC
  const blockTimeCache = new Map();
  async function blockTimeOf(blockNumberHex) {
    const n = hexToNumber(blockNumberHex);
    if (blockTimeCache.has(n)) return blockTimeCache.get(n);
    const blk = await rpcCall(rpcUrl, "eth_getBlockByNumber", [blockNumberHex, false]);
    const ts = hexToNumber(blk.timestamp);
    const d = new Date(ts * 1000);
    blockTimeCache.set(n, d);
    return d;
  }

  let inserted = 0;
  for (const log of logs) {
    try {
      const from = topicToAddress(log.topics[1]);
      const to   = topicToAddress(log.topics[2]);
      const amt  = Number(hexToBigInt(log.data)) / Math.pow(10, decimals);
      const usd  = price ? amt * price : 0;
      const { direction, exchange_name } = directionAndName(from, to, exMap);
      const blockTime = await blockTimeOf(log.blockNumber);

      await insertTransfer({
        coin_id: coin.id,
        chain: coin.chain || "",
        tx_hash: log.transactionHash,
        from_address: from,
        to_address: to,
        amount_token: amt,
        amount_usd: usd,
        block_number: hexToNumber(log.blockNumber),
        block_time: blockTime,
        direction,
        exchange_name,
        is_large: usd >= LARGE_USD,
        source: "rpc"
      });
      inserted++;
    } catch (e) {
      console.warn("insert log failed:", e.message);
    }
  }
  return inserted;
}

// ========== runners ==========
export async function runOnchainWorker() {
  const { rows: coins } = await q(
    `SELECT id, symbol, chain, contract_address, decimals
       FROM crypto_assets WHERE is_active=true`
  );
  let total = 0;
  for (const c of coins) {
    try {
      const n = await fetchFromRPC(c).catch(() => 0);
      total += n;
      await sleep(200);
    } catch (e) {
      console.warn("onchain_worker:", c.symbol, e.message);
    }
  }
  return total;
}

export async function runOnchainForSymbol(symbol) {
  const { rows } = await q(
    `SELECT id, symbol, chain, contract_address, decimals
       FROM crypto_assets WHERE is_active=true AND UPPER(symbol)=UPPER($1)`,
    [symbol]
  );
  if (!rows.length) return 0;
  return fetchFromRPC(rows[0]).catch(() => 0);
}

// CLI
if (process.argv[1] && process.argv[1].endsWith("onchain_worker.js")) {
  runOnchainWorker().then(n => {
    console.log("onchain_worker inserted:", n);
    process.exit(0);
  });
}
