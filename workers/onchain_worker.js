// backend/workers/onchain_worker.js
import { q } from "../utils/db.js";

const COVALENT_KEY = process.env.COVALENT_KEY || "";
const LARGE_USD = Number(process.env.ONCHAIN_LARGE_USD || 100000);

function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

// Map chuỗi chain trong DB -> chain_id Covalent
const COVALENT_CHAIN_ID = {
  "ETHEREUM": 1,
  "BSC": 56,
  "BINANCE SMART CHAIN": 56,
  "POLYGON": 137,
  "MATIC": 137,
  "ARBITRUM": 42161,
  "OPTIMISM": 10,
  "AVALANCHE": 43114,
  "BASE": 8453,
};

// lấy close mới nhất 15m để ước USD
async function latestPriceUSD(coin_id){
  const { rows } = await q(
    `SELECT close FROM price_ohlc 
     WHERE coin_id=$1 AND timeframe='15m' 
     ORDER BY close_time DESC LIMIT 1`,
    [coin_id]
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
  for (const r of rows) m.set(r.address?.toLowerCase(), { name: r.name, is_deposit: r.is_deposit });
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
      row.coin_id, row.chain, row.tx_hash, row.from_address, row.to_address, row.amount_token, row.amount_usd,
      row.block_number, row.block_time, row.direction, row.exchange_name, row.is_large, row.source
    ]
  );
}

// ------- Covalent (EVM ERC20) -------
async function fetchFromCovalent(coin){
  if (!COVALENT_KEY) return 0;
  const chainId = COVALENT_CHAIN_ID[(coin.chain || "").toUpperCase()];
  if (!chainId) return 0;
  if (!coin.contract_address) return 0; // ERC20 bắt buộc có contract

  // lấy exchange map
  const exMap = await loadExchangeMap(coin.chain || "");

  // lấy giá ước tính
  const px = await latestPriceUSD(coin.id);
  // decimals mặc định 18 nếu không có
  const decimals = Number.isFinite(Number(coin.decimals)) ? Number(coin.decimals) : 18;

  // Lấy 24h gần nhất
  const now = new Date();
  const since = new Date(now.getTime() - 24*3600*1000).toISOString();
  // Covalent transfers_v2
  const url = `https://api.covalenthq.com/v1/${chainId}/address/${coin.contract_address}/transfers_v2/?key=${COVALENT_KEY}&page-size=1000&starting-block=0&ending-block=latest`;
  const r = await fetch(url, { headers: { accept: "application/json" } });
  if (!r.ok) {
    if (r.status === 429) { await sleep(1200); return fetchFromCovalent(coin); }
    throw new Error(`Covalent status ${r.status}`);
  }
  const j = await r.json();
  const data = j?.data?.items || [];

  let ins = 0;
  for (const it of data) {
    // Covalent trả nhiều tx; mỗi tx có "transfers" mảng log
    const txHash = it?.tx_hash;
    const bn = it?.block_height;
    const t = it?.block_signed_at ? new Date(it.block_signed_at) : null;
    if (!t || t.toISOString() < since) continue; // chỉ lấy 24h gần nhất

    const transfers = Array.isArray(it?.transfers) ? it.transfers : [];
    for (const tr of transfers) {
      if ((tr?.contract_address || "").toLowerCase() !== (coin.contract_address || "").toLowerCase()) continue;

      const from = tr?.from_address;
      const to   = tr?.to_address;
      const raw  = tr?.delta ? String(tr.delta) : (tr?.value ? String(tr.value) : "0");
      const amountToken = Number(raw) / Math.pow(10, decimals);

      // ước USD: nếu không có giá thì skip large flag, vẫn lưu 0
      const usd = px ? amountToken * Number(px) : 0;
      const { direction, exchange_name } = directionAndName(from, to, exMap);
      const is_large = usd >= LARGE_USD;

      await insertTransfer({
        coin_id: coin.id,
        chain: coin.chain || "",
        tx_hash: txHash,
        from_address: from,
        to_address: to,
        amount_token: amountToken,
        amount_usd: usd,
        block_number: bn || null,
        block_time: t,
        direction,
        exchange_name,
        is_large,
        source: "covalent"
      });
      ins++;
    }
  }
  return ins;
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
      const n = await fetchFromCovalent(c).catch(() => 0);
      total += n;
      await sleep(250);
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
  return fetchFromCovalent(rows[0]).catch(() => 0);
}

// CLI
if (process.argv[1] && process.argv[1].endsWith("onchain_worker.js")) {
  runOnchainWorker().then(n => {
    console.log("onchain_worker inserted:", n);
    process.exit(0);
  });
}
