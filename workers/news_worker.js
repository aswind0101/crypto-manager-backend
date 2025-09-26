// backend/workers/news_worker.js
// Nguồn: NewsAPI (nếu có) -> CryptoPanic (nếu còn quota) -> RSS (free)
// Lọc theo coin.symbol/name, chấm sentiment đơn giản và ghi vào news_items

import { q } from "../utils/db.js";
import { XMLParser } from "fast-xml-parser";

const NEWSAPI_KEY = process.env.NEWSAPI_KEY || "";
const CP_TOKEN = process.env.CP_TOKEN || "";

// Có thể override bằng ENV NEWS_RSS_FEEDS (phân tách bằng dấu phẩy)
const DEFAULT_FEEDS = [
    "https://www.coindesk.com/arc/outboundfeeds/rss/?outputType=xml",
    "https://cointelegraph.com/rss",
    "https://decrypt.co/feed",
    "https://bitcoinmagazine.com/.rss?output=xml",
    "https://cryptoslate.com/feed/",
    "https://ambcrypto.com/feed/",
    "https://www.newsbtc.com/feed/",
];
const RSS_FEEDS = (process.env.NEWS_RSS_FEEDS || DEFAULT_FEEDS.join(","))
    .split(",").map(s => s.trim()).filter(Boolean);

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// sentiment cực nhẹ (fallback)
function naiveSentiment(text = "") {
    const pos = ["surge", "jump", "bull", "up", "growth", "partnership", "adopt", "record", "high", "pump", "gain"];
    const neg = ["hack", "exploit", "down", "bear", "drop", "lawsuit", "ban", "fraud", "risk", "dump", "loss"];
    let s = 0; const t = text.toLowerCase();
    pos.forEach(w => { if (t.includes(w)) s += 1; });
    neg.forEach(w => { if (t.includes(w)) s -= 1; });
    if (s > 0) return Math.min(1, s / 5);
    if (s < 0) return Math.max(-1, s / 5);
    return 0;
}

async function computeSentiment(text = "") {
    try {
        const vader = await import("vader-sentiment");
        const s = vader?.SentimentIntensityAnalyzer?.polarity_scores?.(text)?.compound;
        if (typeof s === "number" && isFinite(s)) return Math.max(-1, Math.min(1, s));
    } catch (_) { }
    // fallback
    return naiveSentiment(text);
}

async function insertNews({ coin_id, source, title, url, published_at, sentiment }) {
    if (!url) return;
    await q(
        `INSERT INTO news_items (coin_id, source, title, url, published_at, sentiment_score)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (source, url) DO NOTHING`,
        [coin_id, source, title || "", url, published_at || null, sentiment]
    );
}

function matchCoin(text, coin) {
    if (!text) return false;
    const s = text.toLowerCase();
    const sym = (coin.symbol || "").toLowerCase();
    const name = (coin.name || "").toLowerCase();
    // BTC đặc biệt: name = "bitcoin"; ETH = "ethereum"
    const symWord = new RegExp(`\\b${sym}\\b`, "i");
    return symWord.test(s) || s.includes(name);
}

// ============== NewsAPI ==============
async function fetchFromNewsAPI(coin) {
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
        if (r.status === 429) { await sleep(1200); return fetchFromNewsAPI(coin); }
        throw new Error(`NewsAPI ${r.status}`);
    }
    const j = await r.json();
    const items = j?.articles || [];
    let n = 0;
    for (const a of items) {
        const title = a?.title || "";
        const desc = a?.description || "";
        const link = a?.url || "";
        const ts = a?.publishedAt ? new Date(a.publishedAt) : null;
        if (!matchCoin(`${title} ${desc}`, coin)) continue;
        // NewsAPI
        const s = await computeSentiment(`${title} ${desc}`);
        await insertNews({ coin_id: coin.id, source: "newsapi", title, url: link, published_at: ts, sentiment: s });
        n++;
    }
    return n;
}

// ============== CryptoPanic ==============
async function fetchFromCryptoPanic(coin) {
    if (!CP_TOKEN) return 0;
    const params = new URLSearchParams({
        auth_token: CP_TOKEN, public: "true", kind: "news", currencies: coin.symbol
    });
    const url = `https://cryptopanic.com/api/v1/posts/?${params.toString()}`;
    const r = await fetch(url, { headers: { accept: "application/json" } });
    if (!r.ok) {
        // Hết quota / rate-limit: 402/429 → fallback
        if (r.status === 402 || r.status === 429) return 0;
        if (r.status >= 500) { await sleep(800); return 0; }
        throw new Error(`CryptoPanic ${r.status}`);
    }
    const j = await r.json();
    const items = j?.results || [];
    let n = 0;
    for (const it of items) {
        const title = it?.title || it?.metadata?.title || "";
        const desc = it?.metadata?.description || "";
        const link = it?.url || it?.metadata?.url || "";
        const ts = it?.published_at ? new Date(it.published_at) : null;
        if (!matchCoin(`${title} ${desc}`, coin)) continue;
        // CryptoPanic
        const s = await computeSentiment(`${title} ${desc}`);
        await insertNews({ coin_id: coin.id, source: "cryptopanic", title, url: link, published_at: ts, sentiment: s });
        n++;
    }
    return n;
}

// ============== RSS (free) ==============
async function fetchFromRSS(coin) {
    const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", textNodeName: "#text" });
    let total = 0;

    for (const feed of RSS_FEEDS) {
        try {
            const r = await fetch(feed, { headers: { "accept": "application/rss+xml, application/xml, text/xml, */*" } });
            if (!r.ok) continue;
            const xml = await r.text();
            const j = parser.parse(xml);

            // Chuẩn hoá items cho cả RSS 2.0 (rss.channel.item) và Atom (feed.entry)
            const items =
                (j?.rss?.channel?.item && Array.isArray(j.rss.channel.item) ? j.rss.channel.item : null) ||
                (j?.feed?.entry && Array.isArray(j.feed.entry) ? j.feed.entry : []) ||
                [];

            const sourceName = `rss:${new URL(feed).hostname}`;

            for (const it of items) {
                const title = String(it?.title?.["#text"] ?? it?.title ?? "").trim();
                const desc = String(it?.description ?? it?.summary ?? "").trim();

                // link có thể nằm ở nhiều chỗ tuỳ feed
                const link =
                    (typeof it?.link === "string" ? it.link :
                        (typeof it?.link?.["@_href"] === "string" ? it.link["@_href"] :
                            (typeof it?.link?.href === "string" ? it.link.href :
                                (typeof it?.guid === "string" ? it.guid : "")))) || "";

                const pubRaw = it?.pubDate || it?.published || it?.updated;
                const ts = pubRaw ? new Date(pubRaw) : null;

                if (!matchCoin(`${title} ${desc}`, coin)) continue;
                // RSS
                const s = await computeSentiment(`${title} ${desc}`);

                await insertNews({
                    coin_id: coin.id, source: sourceName, title, url: link, published_at: ts, sentiment: s
                });
                total++;
            }
            await sleep(200); // dịu tải một chút
        } catch (e) {
            console.warn("RSS error:", feed, e.message);
        }
    }
    return total;
}

// ============== Runners ==============
async function shouldSkipNews(coin_id) {
    // tránh spam nguồn free: bỏ qua nếu đã fetch trong 20 phút qua
    const { rows } = await q(
        `SELECT MAX(created_at) AS last FROM news_items WHERE coin_id=$1`,
        [coin_id]
    );
    const last = rows[0]?.last ? new Date(rows[0].last) : null;
    return last && (Date.now() - last.getTime() < 20 * 60 * 1000);
}

export async function runNewsWorker() {
    const { rows: coins } = await q(`SELECT id, symbol, name FROM crypto_assets WHERE is_active=true`);
    let total = 0;
    for (const coin of coins) {
        try {
            if (await shouldSkipNews(coin.id)) continue;
            const a = await fetchFromNewsAPI(coin).catch(() => 0);
            const b = await fetchFromCryptoPanic(coin).catch(() => 0); // sẽ trả 0 nếu hết quota
            const c = await fetchFromRSS(coin).catch(() => 0);
            total += (a + b + c);
            await sleep(250);
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

    if (await shouldSkipNews(coin.id)) return 0;

    const a = await fetchFromNewsAPI(coin).catch(() => 0);
    const b = await fetchFromCryptoPanic(coin).catch(() => 0);
    const c = await fetchFromRSS(coin).catch(() => 0);
    return a + b + c;
}

// CLI (optional)
if (process.argv[1] && process.argv[1].endsWith("news_worker.js")) {
    runNewsWorker().then(n => {
        console.log("news_worker inserted:", n);
        process.exit(0);
    });
}
