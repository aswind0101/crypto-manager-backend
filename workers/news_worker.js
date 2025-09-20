// backend/workers/news_worker.js
import axios from "axios";
import dayjs from "dayjs";
import { q } from "../utils/db.js";

const NEWSAPI_BASE = process.env.NEWSAPI_BASE || "https://newsapi.org/v2";
const NEWSAPI_KEY = process.env.NEWSAPI_KEY || "";
const CP_BASE = process.env.CRYPTOPANIC_BASE || "https://cryptopanic.com/api/v1";
const CP_TOKEN = process.env.CRYPTOPANIC_TOKEN || "";

async function fetchNewsForCoin(coin) {
    let inserted = 0;

    // NewsAPI
    if (NEWSAPI_KEY) {
        const url = `${NEWSAPI_BASE}/everything?q=${encodeURIComponent(coin.name)}&language=en&sortBy=publishedAt&pageSize=20&apiKey=${NEWSAPI_KEY}`;
        const resp = await axios.get(url);
        const articles = resp.data?.articles || [];
        for (const a of articles) {
            await q(
                `INSERT INTO news_items (coin_id, source, title, url, published_at, sentiment_score)
         VALUES ($1,'newsapi',$2,$3,$4,NULL)
         ON CONFLICT (source, url) DO NOTHING`,
                [coin.id, a.title || "", a.url, a.publishedAt ? dayjs(a.publishedAt).toDate() : null]
            );
            inserted++;
        }
    }

    // CryptoPanic
    if (CP_TOKEN) {
        const url = `${CP_BASE}/posts/?auth_token=${CP_TOKEN}&currencies=${coin.symbol.toLowerCase()}&public=true`;
        const resp = await axios.get(url);
        const posts = resp.data?.results || [];
        for (const p of posts) {
            await q(
                `INSERT INTO news_items (coin_id, source, title, url, published_at, sentiment_score)
         VALUES ($1,'cryptopanic',$2,$3,$4,NULL)
         ON CONFLICT (source, url) DO NOTHING`,
                [coin.id, p.title || "", p.url, p.published_at ? dayjs(p.published_at).toDate() : null]
            );
            inserted++;
        }
    }

    return inserted;
}

export async function runNewsWorker() {
    if (!NEWSAPI_KEY && !CP_TOKEN) {
        console.log("news_worker: no API key -> skipped");
        return 0;
    }
    const { rows: coins } = await q(`SELECT id, symbol, name FROM crypto_assets WHERE is_active=true`);
    let total = 0;
    for (const c of coins) {
        try {
            total += await fetchNewsForCoin(c);
        } catch (e) {
            console.error(`news_worker: ${c.symbol} error:`, e.message);
        }
    }
    console.log(`news_worker: inserted ${total} news rows`);
    return total;
}

export async function runNewsForSymbol(symbol) {
    if (!NEWSAPI_KEY && !CP_TOKEN) return 0;

    const { rows } = await q(
        `SELECT id, symbol, name
     FROM crypto_assets
     WHERE is_active=true AND UPPER(symbol)=UPPER($1)`,
        [symbol]
    );
    if (!rows.length) return 0;

    try {
        return await fetchNewsForCoin(rows[0]);
    } catch (e) {
        console.error("runNewsForSymbol error:", e.message);
        return 0;
    }
}
// If run directly, execute the worker

if (process.argv[1] && process.argv[1].endsWith("news_worker.js")) {
    runNewsWorker().then(() => process.exit(0)).catch(() => process.exit(1));
}
