// backend/workers/onchain_worker.js
// Worker on-chain: ƯU TIÊN NEAR (native transfers) + vẫn hỗ trợ EVM (ERC-20).
// - Lưu vào onchain_transfers (unique: coin_id, tx_hash, log_index)
// - Có cursor DB để không quét trùng; bộ lọc giảm rác; giới hạn rows/mỗi lần chạy.

import { q } from "../utils/db.js";

// =========================== CẤU HÌNH ==============================
const LARGE_USD = Number(process.env.ONCHAIN_LARGE_USD || 100000);
const ONCHAIN_WINDOW_HOURS = Number(process.env.ONCHAIN_WINDOW_HOURS || 12);

// ---- NEAR ----
const NEAR_RPC_URL = process.env.NEAR_RPC_URL || "https://rpc.mainnet.near.org";
const NEAR_BLOCKS_PER_HOUR = Number(process.env.NEAR_BLOCKS_PER_HOUR || 3600);
const NEAR_MAX_BLOCK_BACK = Number(process.env.NEAR_MAX_BLOCK_BACK || 20000);

// ---- EVM (để dành cho các chain khác) ----
const RPC = {
  ETHEREUM: process.env.ETH_RPC_URL || "https://cloudflare-eth.com",
  BSC: process.env.BSC_RPC_URL || "https://bsc-dataseed.binance.org",
  POLYGON: process.env.POLYGON_RPC_URL || "https://polygon-rpc.com",
  ARBITRUM: process.env.ARBITRUM_RPC_URL || "https://arb1.arbitrum.io/rpc",
  OPTIMISM: process.env.OPTIMISM_RPC_URL || "https://mainnet.optimism.io",
  BASE: process.env.BASE_RPC_URL || "https://mainnet.base.org",
  AVALANCHE: process.env.AVAX_RPC_URL || "https://api.avax.network/ext/bc/C/rpc",
};

// ---- Bộ lọc giảm số dòng ghi DB ----
const FILTER_EXCH_ONLY = (process.env.ONCHAIN_FILTER_EXCHANGES_ONLY || "true") === "true"; // chỉ lưu nếu có sàn hoặc giao dịch lớn
const MIN_USD = Number(process.env.ONCHAIN_MIN_USD || 1000);                               // ngưỡng USD tối thiểu
const IGNORE_SELF = (process.env.ONCHAIN_IGNORE_SELF_TRANSFERS || "true") === "true";      // bỏ signer==receiver / from==to
const MAX_ROWS_PER_RUN = Number(process.env.ONCHAIN_MAX_ROWS_PER_RUN || 8000);             // nắp an toàn mỗi lần chạy

// =========================== TIỆN ÍCH CHUNG ========================
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Giá USD (ưu tiên 15m → fallback 1h)
async function latestPriceUSD(coin_id) {
  const { rows } = await q(
    `SELECT close FROM price_ohlc
     WHERE coin_id=$1 AND timeframe='15m'
     ORDER BY close_time DESC LIMIT 1`, [coin_id]
  );
  if (rows[0]?.close) return Number(rows[0].close);

  const { rows: r1 } = await q(
    `SELECT close FROM price_ohlc
     WHERE coin_id=$1 AND timeframe='1h'
     ORDER BY close_time DESC LIMIT 1`, [coin_id]
  );
  return r1[0]?.close ? Number(r1[0].close) : null;
}

// Map địa chỉ sàn theo chain
async function loadExchangeMap(chain) {
  const { rows } = await q(
    `SELECT LOWER(address) AS addr, name, is_deposit
       FROM exchange_addresses
      WHERE is_active=true AND UPPER(chain)=UPPER($1)`,
    [chain]
  );
  const m = new Map();
  for (const r of rows) m.set(r.addr, { name: r.name, is_deposit: r.is_deposit });
  return m;
}

// Xác định hướng & tên sàn
function directionAndName(from, to, exMap) {
  const f = exMap.get(String(from || "").toLowerCase());
  const t = exMap.get(String(to || "").toLowerCase());
  if (t) return { direction: "to_exchange", exchange_name: t.name };
  if (f) return { direction: "from_exchange", exchange_name: f.name };
  return { direction: "unknown", exchange_name: null };
}

// Insert chuẩn (có log_index + ON CONFLICT đúng)
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

// ===== cursor DB để không quét trùng =====
async function getCursor(key) {
  const { rows } = await q(`SELECT last_pos FROM scan_cursors WHERE key=$1`, [key]);
  return rows[0]?.last_pos ?? null;
}
async function setCursor(key, pos) {
  await q(
    `INSERT INTO scan_cursors(key,last_pos) VALUES ($1,$2)
     ON CONFLICT (key) DO UPDATE SET last_pos=EXCLUDED.last_pos, updated_at=now()`,
    [key, pos]
  );
}

// ===== Generic JSON-RPC caller =====
let rpcId = 1;
async function rpcCall(rpcUrl, method, params = [], timeoutMs = 15000) {
  if (!/^https?:\/\//i.test(String(rpcUrl || ""))) throw new Error(`Invalid RPC URL: ${rpcUrl}`);
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

// ============================== NEAR ===============================
// NEAR timestamp → Date
function nearHeaderToDate(header) {
  const ns = header?.timestamp_nanosec ?? header?.timestamp;
  try { return new Date(Number(BigInt(ns) / 1000000n)); } catch { return new Date(); }
}
async function nearGetLatestBlock() { return rpcCall(NEAR_RPC_URL, "block", { finality: "final" }); }
async function nearGetBlockByHeight(h) { return rpcCall(NEAR_RPC_URL, "block", { block_id: h }); }
async function nearGetChunk(ch) {
  try { return await rpcCall(NEAR_RPC_URL, "chunk", [ch]); }
  catch { return await rpcCall(NEAR_RPC_URL, "chunk", { chunk_id: ch }); }
}

/**
 * Quét native NEAR transfers (action.Transfer.deposit):
 * - Duyệt block → chunk → transaction → actions
 * - Lọc: chỉ lưu khi có sàn tham gia hoặc usd >= MIN_USD; bỏ self-transfer nếu bật
 * - log_index = index của action trong transaction
 */
async function fetchFromNEAR(coin) {
  const chainKey = String(coin.chain || "").toUpperCase();
  const isNEAR = chainKey === "NEAR" || String(coin.symbol || "").toUpperCase() === "NEAR";
  if (!isNEAR) return 0;

  const cursorKey = `onchain:near:${coin.symbol}`;
  const exMap = await loadExchangeMap("NEAR");
  const price = await latestPriceUSD(coin.id);
  const decimals = Number.isFinite(Number(coin.decimals)) ? Number(coin.decimals) : 24;

  const latest = await nearGetLatestBlock();
  const latestHeight = Number(latest?.header?.height || 0);
  if (!latestHeight) return 0;

  const cursor = await getCursor(cursorKey);
  const backByWindow = Math.floor(ONCHAIN_WINDOW_HOURS * NEAR_BLOCKS_PER_HOUR);
  const safeBack = Math.min(Math.max(1, backByWindow), NEAR_MAX_BLOCK_BACK);
  let fromHeight = cursor ? (Number(cursor) + 1) : Math.max(1, latestHeight - safeBack);
  const toHeight = latestHeight;
  if (fromHeight > toHeight) return 0;

  let inserted = 0;

  for (let h = fromHeight; h <= toHeight; h++) {
    if (inserted >= MAX_ROWS_PER_RUN) {
      await setCursor(cursorKey, h - 1);
      console.log(`NEAR cap reached (${inserted}). Saved cursor at ${h - 1}.`);
      return inserted;
    }

    let block;
    try { block = await nearGetBlockByHeight(h); }
    catch (e) { console.warn("NEAR block fail:", h, e.message); continue; }

    const blockTime = nearHeaderToDate(block?.header);
    const chunks = Array.isArray(block?.chunks) ? block.chunks : [];

    for (const ch of chunks) {
      const hash = ch?.chunk_hash;
      if (!hash) continue;

      let chunk;
      try { chunk = await nearGetChunk(hash); }
      catch (e) { console.warn("NEAR chunk fail:", String(hash).slice(0, 8), e.message); continue; }

      const txs = Array.isArray(chunk?.transactions) ? chunk.transactions : [];
      for (const tx of txs) {
        const signer = tx?.signer_id;
        const receiver = tx?.receiver_id;
        const txHash = tx?.hash;
        const actions = Array.isArray(tx?.actions) ? tx.actions : [];
        if (!txHash || !signer || !receiver || !actions.length) continue;

        for (let ai = 0; ai < actions.length; ai++) {
          const act = actions[ai] || {};
          if (!act.Transfer || !act.Transfer.deposit) continue; // chỉ lấy native transfer

          // amount
          const yocto = String(act.Transfer.deposit);
          const amt = Number(BigInt(yocto)) / Math.pow(10, decimals);
          if (!Number.isFinite(amt) || amt <= 0) continue;

          if (IGNORE_SELF && signer === receiver) continue;

          const usd = price ? amt * price : 0;
          const { direction, exchange_name } = directionAndName(signer, receiver, exMap);

          // Bộ lọc giảm rác
          const involveExchange = !!exchange_name;
          const passUsd = usd >= MIN_USD;
          if ((FILTER_EXCH_ONLY && !involveExchange && !passUsd) ||
              (!FILTER_EXCH_ONLY && !passUsd && !involveExchange)) {
            continue;
          }

          try {
            await insertTransfer({
              coin_id: coin.id,
              chain: "NEAR",
              tx_hash: txHash,
              log_index: ai, // unique trong 1 tx
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

          if (inserted >= MAX_ROWS_PER_RUN) break;
        }
        if (inserted >= MAX_ROWS_PER_RUN) break;
      }
      if (inserted >= MAX_ROWS_PER_RUN) break;
      await sleep(50);
    }

    // Lưu tiến độ sau mỗi block để tránh mất cursor khi dừng giữa chừng
    await setCursor(cursorKey, h);
    if (h % 200 === 0) await sleep(120);
  }

  console.log(`onchain_worker(NEAR): ${coin.symbol} inserted ${inserted} rows.`);
  return inserted;
}

// =============================== EVM ===============================
// ERC-20 Transfer topic0
const ERC20_TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

const hexToNumber = (hex) => Number(BigInt(hex));
const hexToBigInt = (hex) => BigInt(hex);
const topicToAddress = (topic) => "0x" + String(topic).slice(-40);

async function estimateBlocksBackEVM(rpcUrl) {
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

  let back = Math.floor((ONCHAIN_WINDOW_HOURS * 3600) / secsPerBlock);
  back = Math.min(Math.max(back, 1500), 120000);
  return { latest, back };
}

async function getTransferLogsInRangeEVM({
  rpcUrl, address, fromBlock, toBlock, initChunk
}) {
  const MIN_CHUNK = 300;
  let chunk = initChunk;
  const logs = [];
  let start = fromBlock;
  const topics = [ERC20_TRANSFER_TOPIC]; // không lọc from/to ở RPC để tránh miss

  while (start <= toBlock) {
    const end = Math.min(start + chunk - 1, toBlock);
    const params = [{
      fromBlock: "0x" + start.toString(16),
      toBlock: "0x" + end.toString(16),
      address,
      topics
    }];

    try {
      const part = await rpcCall(rpcUrl, "eth_getLogs", params, 20000);
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
      console.warn(`eth_getLogs ${start}-${end} failed: ${e.message} → skip`);
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

  const cursorKey = `onchain:evm:${chainKey}:${(coin.contract_address || "").toLowerCase()}`;

  const exMap = await loadExchangeMap(coin.chain || "");
  const price = await latestPriceUSD(coin.id);
  const decimals = Number.isFinite(Number(coin.decimals)) ? Number(coin.decimals) : 18;

  const { latest, back } = await estimateBlocksBackEVM(rpcUrl);

  // Dùng cursor nếu có; nếu chưa có → lùi theo window
  const cursor = await getCursor(cursorKey);
  const fromBlock = Math.max(1, cursor ? Number(cursor) + 1 : latest - back);
  const toBlock = latest;

  if (fromBlock > toBlock) return 0;

  const initChunk = (chainKey === "ETHEREUM") ? 1000 : 4000;
  const logs = await getTransferLogsInRangeEVM({
    rpcUrl, address: coin.contract_address, fromBlock, toBlock, initChunk
  });

  // cache block time
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
    if (inserted >= MAX_ROWS_PER_RUN) break;

    try {
      const from = topicToAddress(log.topics[1]);
      const to = topicToAddress(log.topics[2]);
      if (IGNORE_SELF && from.toLowerCase() === to.toLowerCase()) continue;

      const amt = Number(hexToBigInt(log.data)) / Math.pow(10, decimals);
      if (!Number.isFinite(amt) || amt <= 0) continue;

      const usd = price ? amt * price : 0;
      const { direction, exchange_name } = directionAndName(from, to, exMap);

      // Bộ lọc: có sàn tham gia hoặc usd >= MIN_USD
      const involveExchange = !!exchange_name;
      const passUsd = usd >= MIN_USD;
      if ((FILTER_EXCH_ONLY && !involveExchange && !passUsd) ||
          (!FILTER_EXCH_ONLY && !passUsd && !involveExchange)) {
        continue;
      }

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

  // Lưu cursor tới block đã xử lý
  await setCursor(cursorKey, toBlock);
  console.log(`onchain_worker(EVM): ${coin.symbol} inserted ${inserted} rows (${fromBlock}-${toBlock}).`);
  return inserted;
}

// ============================= RUNNERS =============================
export async function runOnchainWorker() {
  const { rows: coins } = await q(
    `SELECT id, symbol, chain, contract_address, decimals
       FROM crypto_assets
      WHERE is_active=true`
  );

  let total = 0;
  for (const c of coins) {
    try {
      const chainKey = String(c.chain || "").toUpperCase();
      const isNEAR = chainKey === "NEAR" || String(c.symbol || "").toUpperCase() === "NEAR";
      const n = isNEAR ? await fetchFromNEAR(c).catch(() => 0)
                       : await fetchFromEVM(c).catch(() => 0);
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
       FROM crypto_assets
      WHERE is_active=true AND UPPER(symbol)=UPPER($1)`,
    [symbol]
  );
  if (!rows.length) return 0;
  const c = rows[0];
  const chainKey = String(c.chain || "").toUpperCase();
  const isNEAR = chainKey === "NEAR" || String(c.symbol || "").toUpperCase() === "NEAR";
  return isNEAR ? fetchFromNEAR(c) : fetchFromEVM(c);
}

// Cho phép chạy trực tiếp qua "node backend/workers/onchain_worker.js"
if (process.argv[1] && process.argv[1].endsWith("onchain_worker.js")) {
  runOnchainWorker().then(n => {
    console.log("onchain_worker inserted:", n);
    process.exit(0);
  });
}
