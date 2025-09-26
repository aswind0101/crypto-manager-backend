// backend/workers/onchain_worker.js
// On-chain worker: ƯU TIÊN NEAR (native transfers), vẫn hỗ trợ EVM (ERC-20).
// - NEAR: Quét block -> chunk -> transactions -> actions.Transfer (native NEAR)
// - EVM:  Đọc ERC-20 Transfer logs theo khoảng thời gian cấu hình
// - Lưu vào onchain_transfers (unique: coin_id, tx_hash, log_index)

import { q } from "../utils/db.js";

// ===== Config =====
const LARGE_USD = Number(process.env.ONCHAIN_LARGE_USD || 100000);
const ONCHAIN_WINDOW_HOURS = Number(process.env.ONCHAIN_WINDOW_HOURS || 12);

// NEAR RPC (ưu tiên NEAR theo yêu cầu)
const NEAR_RPC_URL = process.env.NEAR_RPC_URL || "https://rpc.mainnet.near.org";
const NEAR_BLOCKS_PER_HOUR = Number(process.env.NEAR_BLOCKS_PER_HOUR || 3600); // ~1 block/s

// EVM RPC (để dành cho các chain khác, không ảnh hưởng NEAR)
const RPC = {
  ETHEREUM: process.env.ETH_RPC_URL || "https://cloudflare-eth.com",
  BSC: process.env.BSC_RPC_URL || "https://bsc-dataseed.binance.org",
  POLYGON: process.env.POLYGON_RPC_URL || "https://polygon-rpc.com",
  ARBITRUM: process.env.ARBITRUM_RPC_URL || "https://arb1.arbitrum.io/rpc",
  OPTIMISM: process.env.OPTIMISM_RPC_URL || "https://mainnet.optimism.io",
  BASE: process.env.BASE_RPC_URL || "https://mainnet.base.org",
  AVALANCHE: process.env.AVAX_RPC_URL || "https://api.avax.network/ext/bc/C/rpc",
};

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ===== Common DB helpers =====
async function latestPriceUSD(coin_id) {
  // ưu tiên 15m, fallback 1h
  const { rows } = await q(
    `SELECT close FROM price_ohlc
     WHERE coin_id=$1 AND timeframe='15m'
     ORDER BY close_time DESC LIMIT 1`,
    [coin_id]
  );
  if (rows[0]?.close) return Number(rows[0].close);

  const { rows: r1h } = await q(
    `SELECT close FROM price_ohlc
     WHERE coin_id=$1 AND timeframe='1h'
     ORDER BY close_time DESC LIMIT 1`,
    [coin_id]
  );
  return r1h[0]?.close ? Number(r1h[0].close) : null;
}

async function loadExchangeMap(chain) {
  const { rows } = await q(
    `SELECT address, name, is_deposit
       FROM exchange_addresses
      WHERE is_active=true AND UPPER(chain)=UPPER($1)`,
    [chain]
  );
  const m = new Map();
  for (const r of rows) m.set(String(r.address || "").toLowerCase(), { name: r.name, is_deposit: r.is_deposit });
  return m;
}

function directionAndName(from, to, exchangeMap) {
  const f = exchangeMap.get(String(from || "").toLowerCase());
  const t = exchangeMap.get(String(to || "").toLowerCase());
  if (t) return { direction: "to_exchange",   exchange_name: t.name };
  if (f) return { direction: "from_exchange", exchange_name: f.name };
  return { direction: "unknown", exchange_name: null };
}

async function insertTransfer(row) {
  await q(
    `INSERT INTO onchain_transfers
       (coin_id, chain, tx_hash, log_index, from_address, to_address, amount_token, amount_usd,
        block_number, block_time, direction, exchange_name, is_large, source)
     VALUES
       ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     ON CONFLICT (coin_id, tx_hash, log_index) DO NOTHING`,
    [
      row.coin_id, row.chain, row.tx_hash, row.log_index, row.from_address, row.to_address,
      row.amount_token, row.amount_usd, row.block_number, row.block_time,
      row.direction, row.exchange_name, row.is_large, row.source
    ]
  );
}

// ===== Generic JSON-RPC caller =====
let rpcId = 1;
async function rpcCall(rpcUrl, method, params = [], timeoutMs = 12000) {
  if (!/^https?:\/\//i.test(String(rpcUrl || ""))) {
    throw new Error(`Invalid RPC URL: ${rpcUrl}`);
  }
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

// ===================================================================
// ============================ NEAR SCAN ============================
// ===================================================================

// NEAR: timestamp (nanosec string) -> Date
function nearHeaderToDate(header) {
  const ns = header?.timestamp_nanosec ?? header?.timestamp; // both are strings in NEAR RPC
  if (!ns) return new Date();
  try {
    const ms = Number(BigInt(ns) / 1000000n);
    return new Date(ms);
  } catch {
    return new Date();
  }
}

async function nearGetLatestBlock() {
  // finality 'final'
  return rpcCall(NEAR_RPC_URL, "block", { finality: "final" });
}
async function nearGetBlockByHeight(height) {
  return rpcCall(NEAR_RPC_URL, "block", { block_id: height });
}
async function nearGetChunk(chunkHash) {
  // NEAR chấp nhận params dạng mảng hoặc object tuỳ phiên bản, thử mảng trước
  try {
    return await rpcCall(NEAR_RPC_URL, "chunk", [chunkHash]);
  } catch {
    return await rpcCall(NEAR_RPC_URL, "chunk", { chunk_id: chunkHash });
  }
}

/**
 * Quét native NEAR transfers:
 * - Duyệt block theo height trong cửa sổ cấu hình
 * - Mỗi block -> các chunk -> transactions -> actions
 * - action.Transfer.deposit => chuyển NEAR từ signer_id -> receiver_id
 */
async function fetchFromNEAR(coin) {
  // Bảo vệ: chỉ chạy khi đúng chain NEAR hoặc symbol NEAR
  const chainKey = String(coin.chain || "").toUpperCase();
  const isNEAR = chainKey === "NEAR" || String(coin.symbol || "").toUpperCase() === "NEAR";
  if (!isNEAR) return 0;

  const exMap = await loadExchangeMap("NEAR");
  const price = await latestPriceUSD(coin.id);
  const decimals = Number.isFinite(Number(coin.decimals)) ? Number(coin.decimals) : 24; // NEAR = 24

  // Xác định khoảng block
  const latest = await nearGetLatestBlock();
  const latestHeight = Number(latest?.header?.height || 0);
  if (!latestHeight) return 0;

  let back = Math.max(1, Math.floor(ONCHAIN_WINDOW_HOURS * NEAR_BLOCKS_PER_HOUR));
  // tránh quét quá rộng trong 1 lần (an toàn)
  back = Math.min(back, Number(process.env.NEAR_MAX_BLOCK_BACK || 20000));
  const fromHeight = Math.max(1, latestHeight - back);
  const toHeight = latestHeight;

  let inserted = 0;

  for (let h = fromHeight; h <= toHeight; h++) {
    let block;
    try {
      block = await nearGetBlockByHeight(h);
    } catch (e) {
      console.warn("NEAR block fetch fail:", h, e.message);
      continue;
    }
    const blockTime = nearHeaderToDate(block?.header);
    const chunks = Array.isArray(block?.chunks) ? block.chunks : [];

    for (const ch of chunks) {
      const chunkHash = ch?.chunk_hash || ch?.chunk_hash; // property giữ nguyên để phòng version khác nhau
      if (!chunkHash) continue;

      let chunk;
      try {
        chunk = await nearGetChunk(chunkHash);
      } catch (e) {
        console.warn("NEAR chunk fetch fail:", String(chunkHash).slice(0, 8), e.message);
        continue;
      }

      const txs = Array.isArray(chunk?.transactions) ? chunk.transactions : [];
      // Duyệt từng transaction
      for (let txIdx = 0; txIdx < txs.length; txIdx++) {
        const tx = txs[txIdx];
        const signer = tx?.signer_id;
        const receiver = tx?.receiver_id;
        const txHash = tx?.hash;
        const actions = Array.isArray(tx?.actions) ? tx.actions : [];
        if (!txHash || !signer || !receiver || !actions.length) continue;

        for (let ai = 0; ai < actions.length; ai++) {
          const act = actions[ai] || {};
          // NEAR RPC biểu diễn action dưới dạng { Transfer: { deposit: "..." } } hoặc { FunctionCall: {...} }
          if (act.Transfer && act.Transfer.deposit) {
            // native NEAR transfer
            try {
              const yocto = String(act.Transfer.deposit); // string
              // Convert yocto -> token amount theo decimals (NEAR = 24)
              const amt = Number(BigInt(yocto)) / Math.pow(10, decimals);
              const usd = price ? amt * price : 0;
              const { direction, exchange_name } = directionAndName(signer, receiver, exMap);

              await insertTransfer({
                coin_id: coin.id,
                chain: "NEAR",
                tx_hash: txHash,
                log_index: ai, // unique trong tx; đủ cho (coin_id, tx_hash, log_index)
                from_address: signer,
                to_address: receiver,
                amount_token: amt,
                amount_usd: usd,
                block_number: h,
                block_time: blockTime,
                direction,
                exchange_name,
                is_large: usd >= LARGE_USD,
                source: "near-rpc"
              });
              inserted++;
            } catch (e) {
              console.warn("NEAR insert fail:", e.message);
            }
          }
        }
      }

      // dịu tải RPC NEAR
      await sleep(80);
    }

    // nhẹ tải giữa các block
    if (h % 200 === 0) await sleep(150);
  }

  console.log(`onchain_worker(NEAR): ${coin.symbol} inserted ${inserted} rows in heights ${fromHeight}-${toHeight}`);
  return inserted;
}

// ===================================================================
// ============================ EVM SCAN =============================
// ===================================================================

// EVM ERC-20 Transfer topic0
const ERC20_TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

// 20 bytes -> 32 bytes topic
function addrToTopic32(addr) {
  const a = String(addr || "").trim().toLowerCase().replace(/^0x/, "");
  return "0x" + "0".repeat(64 - a.length) + a;
}
function buildTransferTopics(fromList = null, toList = null) {
  const topics = [ERC20_TRANSFER_TOPIC];
  if (Array.isArray(fromList) && fromList.length) topics[1] = fromList.map(addrToTopic32);
  if (Array.isArray(toList) && toList.length) topics[2] = toList.map(addrToTopic32);
  return topics;
}

const hexToNumber = (hex) => Number(BigInt(hex));
const hexToBigInt = (hex) => BigInt(hex);
const topicToAddress = (topic) => "0x" + String(topic).slice(-40);

async function estimateBlocksBackEVM(rpcUrl) {
  const windowHours = ONCHAIN_WINDOW_HOURS;
  const latestHex = await rpcCall(rpcUrl, "eth_blockNumber", []);
  const latest = hexToNumber(latestHex);

  const probe = Math.max(latest - 5000, 1);
  const [bLatest, bProbe] = await Promise.all([
    rpcCall(rpcUrl, "eth_getBlockByNumber", [latestHex, false]),
    rpcCall(rpcUrl, "eth_getBlockByNumber", ["0x" + probe.toString(16), false]),
  ]);
  const tsLatest = hexToNumber(bLatest.timestamp);
  const tsProbe = hexToNumber(bProbe.timestamp);
  const secsPerBlock = Math.max(1, (tsLatest - tsProbe) / (latest - probe));

  let back = Math.floor((windowHours * 3600) / secsPerBlock);
  back = Math.min(Math.max(back, 1500), 120000);
  return { latest, back };
}

async function getTransferLogsInRangeEVM({
  rpcUrl, address, fromBlock, toBlock, initChunk, fromAddresses = null, toAddresses = null
}) {
  const MIN_CHUNK = 300;
  let chunk = initChunk;
  const logs = [];
  let start = fromBlock;
  const topics = buildTransferTopics(fromAddresses, toAddresses);

  while (start <= toBlock) {
    const end = Math.min(start + chunk - 1, toBlock);
    const params = [{
      fromBlock: "0x" + start.toString(16),
      toBlock: "0x" + end.toString(16),
      address,
      topics
    }];

    try {
      const part = await rpcCall(rpcUrl, "eth_getLogs", params, 15000);
      logs.push(...(Array.isArray(part) ? part : []));
      start = end + 1;
      await sleep(250);
    } catch (e) {
      const msg = (e.message || "").toLowerCase();
      const isLimit = msg.includes("limit") || msg.includes("exceed") || msg.includes("more than") ||
        msg.includes("server error") || msg.includes("response size");
      const isRate = msg.includes("rate") || msg.includes("too many") || msg.includes("timeout");

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

async function fetchFromEVM(coin) {
  const chainKey = (coin.chain || "").toUpperCase();
  const rpcUrl = RPC[chainKey];
  if (!rpcUrl) return 0;
  if (!coin.contract_address) return 0;

  const exMap = await loadExchangeMap(coin.chain || "");
  const price = await latestPriceUSD(coin.id);
  const decimals = Number.isFinite(Number(coin.decimals)) ? Number(coin.decimals) : 18;

  const { latest, back } = await estimateBlocksBackEVM(rpcUrl);
  const fromBlock = Math.max(1, latest - back);
  const toBlock = latest;
  const initChunk = (chainKey === "ETHEREUM") ? 1000 : 4000;

  const fromAddresses = null;
  const toAddresses = null;

  const logs = await getTransferLogsInRangeEVM({
    rpcUrl, address: coin.contract_address, fromBlock, toBlock, initChunk,
    fromAddresses, toAddresses
  });

  // Cache block time
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
      const to = topicToAddress(log.topics[2]);
      const amt = Number(hexToBigInt(log.data)) / Math.pow(10, decimals);
      const usd = price ? amt * price : 0;
      const { direction, exchange_name } = directionAndName(from, to, exMap);
      const blockTime = await blockTimeOf(log.blockNumber);
      const logIdx = hexToNumber(log.logIndex);

      await insertTransfer({
        coin_id: coin.id,
        chain: coin.chain || "",
        tx_hash: log.transactionHash,
        log_index: logIdx,
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
      console.warn("EVM insert fail:", e.message);
    }
  }

  console.log(`onchain_worker(EVM): ${coin.symbol} ${inserted} rows inserted in ${fromBlock}-${toBlock}`);
  return inserted;
}

// ===================================================================
// ============================ RUNNERS ==============================
// ===================================================================

export async function runOnchainWorker() {
  const { rows: coins } = await q(
    `SELECT id, symbol, chain, contract_address, decimals
       FROM crypto_assets WHERE is_active=true`
  );

  let total = 0;
  for (const c of coins) {
    try {
      const chainKey = String(c.chain || "").toUpperCase();
      const isNEAR = chainKey === "NEAR" || String(c.symbol || "").toUpperCase() === "NEAR";
      const n = isNEAR ? await fetchFromNEAR(c) : await fetchFromEVM(c);
      total += n;
      await sleep(150);
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
  const c = rows[0];
  const chainKey = String(c.chain || "").toUpperCase();
  const isNEAR = chainKey === "NEAR" || String(c.symbol || "").toUpperCase() === "NEAR";
  return isNEAR ? fetchFromNEAR(c) : fetchFromEVM(c);
}

// CLI
if (process.argv[1] && process.argv[1].endsWith("onchain_worker.js")) {
  runOnchainWorker().then(n => {
    console.log("onchain_worker inserted:", n);
    process.exit(0);
  });
}
