// backend/workers/onchain_worker.js
import axios from "axios";
import dayjs from "dayjs";
import { q } from "../utils/db.js";

// Ngưỡng large transfer (USD) để gắn is_large
const LARGE_USD = 100000; // 100k$ tuỳ chỉnh sau

const COVALENT_BASE = process.env.COVALENT_API_BASE || "https://api.covalenthq.com/v1";
const COVALENT_KEY  = process.env.COVALENT_API_KEY || "";
const ETHERSCAN_BASE = process.env.ETHERSCAN_API_BASE || "https://api.etherscan.io/api";
const ETHERSCAN_KEY  = process.env.ETHERSCAN_API_KEY || "";

// Map chain của coin sang Covalent chain_id nếu có
function guessCovalentChainId(chain) {
  const c = (chain || "").toLowerCase();
  if (c.includes("eth")) return 1;
  if (c.includes("bsc") || c.includes("binance")) return 56;
  if (c.includes("polygon")) return 137;
  return null;
}

async function fetchFromCovalent(coin) {
  // Cần contract_address + chain_id
  const chainId = guessCovalentChainId(coin.chain);
  if (!chainId || !coin.contract_address) return 0;

  // Covalent: /{chain_id}/tokens/{contract_address}/token_transfers/
  const url = `${COVALENT_BASE}/${chainId}/tokens/${coin.contract_address}/token_transfers/?key=${COVALENT_KEY}&page-size=200`;

  const resp = await axios.get(url);
  const items = resp.data?.data?.items || [];
  let inserted = 0;

  for (const it of items) {
    const txHash = it.tx_hash;
    const ts = it.block_signed_at ? dayjs(it.block_signed_at).toDate() : null;
    const from = it.from_address;
    const to   = it.to_address;
    const amountToken = (Number(it.delta) / Math.pow(10, coin.decimals || 18)) || null;

    // Ước tính USD từ close giá gần nhất trong price_ohlc (15m)
    const { rows: px } = await q(
      `SELECT close FROM price_ohlc WHERE coin_id = $1 AND timeframe='15m' ORDER BY close_time DESC LIMIT 1`,
      [coin.id]
    );
    const price = px[0]?.close || null;
    const amountUsd = price && amountToken ? (price * amountToken) : null;

    // map direction theo exchange_addresses
    let direction = "unknown";
    let exchange_name = null;

    if (to) {
      const exTo = await q(`SELECT name FROM exchange_addresses WHERE chain=$1 AND address=LOWER($2) AND is_active=true`, [coin.chain, to.toLowerCase()]);
      if (exTo.rows[0]) {
        direction = "to_exchange"; exchange_name = exTo.rows[0].name;
      }
    }
    if (direction === "unknown" && from) {
      const exFrom = await q(`SELECT name FROM exchange_addresses WHERE chain=$1 AND address=LOWER($2) AND is_active=true`, [coin.chain, from.toLowerCase()]);
      if (exFrom.rows[0]) {
        direction = "from_exchange"; exchange_name = exFrom.rows[0].name;
      }
    }

    const isLarge = amountUsd ? amountUsd >= LARGE_USD : false;

    await q(
      `INSERT INTO onchain_transfers
       (coin_id, chain, tx_hash, from_address, to_address, amount_token, amount_usd, block_number, block_time, direction, exchange_name, is_large, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'covalent')
       ON CONFLICT DO NOTHING`,
      [
        coin.id, coin.chain || "unknown", txHash, from, to, amountToken, amountUsd,
        it.block_height || null, ts, direction, exchange_name, isLarge
      ]
    );
    inserted++;
  }
  return inserted;
}

export async function runOnchainWorker() {
  if (!COVALENT_KEY && !ETHERSCAN_KEY) {
    console.log("onchain_worker: no API key found -> skipped gracefully");
    return 0;
  }

  const { rows: coins } = await q(`SELECT id, symbol, chain, contract_address, decimals FROM crypto_assets WHERE is_active=true`);
  let total = 0;

  for (const coin of coins) {
    try {
      if (COVALENT_KEY) {
        total += await fetchFromCovalent(coin);
      } else {
        // (Tuỳ chọn) thêm fetch Etherscan ERC20 tại đây nếu cần.
        // Hiện mình ưu tiên Covalent do multi-chain tiện hơn.
      }
    } catch (e) {
      console.error(`onchain_worker: ${coin.symbol} error:`, e.message);
    }
  }
  console.log(`onchain_worker: inserted ${total} transfers`);
  return total;
}

// chạy trực tiếp
if (process.argv[1] && process.argv[1].endsWith("onchain_worker.js")) {
  runOnchainWorker().then(()=>process.exit(0)).catch(()=>process.exit(1));
}
