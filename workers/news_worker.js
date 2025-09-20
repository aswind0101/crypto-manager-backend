// backend/workers/news_worker.js
import { q } from "../utils/db.js";

const NEWSAPI_KEY = process.env.NEWSAPI_KEY || "";
const CP_TOKEN    = process.env.CP_TOKEN || "";

function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

// sentiment cực nhẹ (fallback). Nếu không đủ “đã tay”, sau có thể `npm i vader-sentiment`
function naiveSentiment(text="") {
  const pos = ["surge","jump","bull","up","growth","partnership","adopt","record","high"];
  const neg = ["hack","exploit","down","bear","drop","lawsuit","ban","fraud","risk"];
  let s = 0;
  const t = text.toLowerCase();
  pos.forEach(w => { if (t.includes(w)) s += 1; });
  neg.forEach(w => { if (t.includes(w)) s -= 1; });
  // scale về [-1,1]
  if (s > 0) return Math.min(1, s / 5);
  if (s < 0) return Math.max(-1, s / 5);
  return 0;
}

async function insertNews({ coin_id, source, title, url, published_at, sentiment }) {
  await q(
    `INSERT INTO news_items (coin_id, source, title, url, published_at, sentiment_score)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (source, url) DO NOTHING`,
    [coin_id, source, title || "", url || "", published_at || null, sentiment]
  );
}

async function fetchFromNewsAPI(coin){
  if (!NEWSAPI_KEY) return 0;
  const params = new URLSearchParams({
    q: `"${coin.name}" OR ${coin.symbol}`,
    language: "en",
    sortBy: "publishedAt",
    pageSize: "50",
    apiKey: NEWSAPI_KEY
  });
  const url = `https://newsapi.org/v2/everything?${params.toString()}`;
  const r = await fetch(url, { headers: { accept: "application/json" } });
  if (!r.ok) {
    // 429 thường xuyên -> chờ nhẹ rồi thử lại 1 lần
    if (r.status === 429) { await sleep(1200); return fetchFromNewsAPI(coin); }
    throw new Error(`NewsAPI status ${r.status}`);
  }
  const j = await r.json();
  const items = j?.articles || [];
  let ins = 0;
  for (const a of items) {
    const title = a?.title || "";
    const url   = a?.url || "";
    const ts    = a?.publishedAt ? new Date(a.publishedAt) : null;
    const s     = naiveSentiment(`${a?.title || ""} ${a?.description || ""}`);
    await insertNews({ coin_id: coin.id, source: "newsapi", title, url, published_at: ts, sentiment: s });
    ins++;
  }
  return ins;
}

async function fetchFromCryptoPanic(coin){
  if (!CP_TOKEN) return 0;
  // dùng `currencies` theo symbol, filter "news" & public
  const params = new URLSearchParams({
    auth_token: CP_TOKEN,
    public: "true",
    kind: "news",
    currencies: coin.symbol
  });
  const url = `https://cryptopanic.com/api/v1/posts/?${params.toString()}`;
  const r = await fetch(url, { headers: { accept: "application/json" } });
  if (!r.ok) {
    if (r.status === 429) { await sleep(1200); return fetchFromCryptoPanic(coin); }
    throw new Error(`CryptoPanic status ${r.status}`);
  }
  const j = await r.json();
  const items = j?.results || [];
  let ins = 0;
  for (const it of items) {
    const title = it?.title || it?.metadata?.title || "";
    const url   = it?.url || it?.metadata?.url || "";
    const ts    = it?.published_at ? new Date(it.published_at) : null;
    const s     = naiveSentiment(`${title} ${it?.metadata?.description || ""}`);
    await insertNews({ coin_id: coin.id, source: "cryptopanic", title, url, published_at: ts, sentiment: s });
    ins++;
  }
  return ins;
}

// ========== runners ==========
export async function runNewsWorker() {
  const { rows: coins } = await q(`SELECT id, symbol, name FROM crypto_assets WHERE is_active=true`);
  let total = 0;
  for (const coin of coins) {
    try {
      const a = await fetchFromNewsAPI(coin).catch(() => 0);
      const b = await fetchFromCryptoPanic(coin).catch(() => 0);
      total += (a + b);
      await sleep(250); // dịu rate
    } catch (e) {
      console.warn("news_worker:", coin.symbol, e.message);
    }
  }
  return total;
}

export async function runNewsForSymbol(symbol) {
  const { rows } = await q(
    `SELECT id, symbol, name FROM crypto_assets WHERE is_active=true AND UPPER(symbol)=UPPER($1)`,
    [symbol]
  );
  if (!rows.length) return 0;
  const coin = rows[0];
  const a = await fetchFromNewsAPI(coin).catch(() => 0);
  const b = await fetchFromCryptoPanic(coin).catch(() => 0);
  return a + b;
}

// CLI
if (process.argv[1] && process.argv[1].endsWith("news_worker.js")) {
  runNewsWorker().then(n => {
    console.log("news_worker inserted:", n);
    process.exit(0);
  });
}
