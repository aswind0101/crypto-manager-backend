import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import axios from "axios";
import coinListRoute from './routes/coinList.js';
import { sendAlertEmail } from "./utils/sendAlertEmail.js";
//=====================Coin Analyzer============================================
import cron from "node-cron";
import { runPriceWorker } from "./workers/price_worker.js";
import { runOnchainWorker } from "./workers/onchain_worker.js";
import { runNewsWorker } from "./workers/news_worker.js";



import pkg from "pg";
const { Pool } = pkg; // ✅ Chính xác

import verifyToken from "./middleware/verifyToken.js"; // nhớ thêm .js

dotenv.config({ path: "./backend/.env" }); // hoặc ".env" nếu bạn dùng file đó

// ======================= Cleanup config =======================
const ONCHAIN_RETENTION_DAYS = Number(process.env.ONCHAIN_RETENTION_DAYS || 14);    // giữ lại 14 ngày
const ONCHAIN_CLEANUP_BATCH = Number(process.env.ONCHAIN_CLEANUP_BATCH || 200000); // xóa theo lô 200k
const CLEANUP_CRON_TZ = process.env.CRON_TZ || "UTC";                        // múi giờ cron (tùy chọn)

// ==== server.js ====
//const express = require("express");
//const cors = require("cors");
//require("dotenv").config();
//const { Pool } = require("pg");
//const verifyToken = require("./middleware/verifyToken");

//Header
const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());
app.use("/api/coin-list", coinListRoute);

import priceRoute from './routes/price.js';
app.use("/api/price", priceRoute);
import expensesRoute from './routes/expenses.js';
app.use("/api/expenses", expensesRoute);
import categoriesRoute from './routes/categories.js';
app.use("/api/categories", categoriesRoute);
import debtsRoute from './routes/debts.js';
import debtPaymentsRoute from './routes/debtPayments.js';
app.use("/api/debts", debtsRoute);
app.use("/api/debt-payments", debtPaymentsRoute);
import lendersRoute from './routes/lenders.js';
app.use("/api/lenders", lendersRoute);
//=============================Nội dung của ứng dụng Nails & Hair Salon=================================
import salonsRoute from './routes/salons.js';
import authRoutes from "./routes/auth.js";
import employeesRoute from './routes/employees.js';

app.use("/api/employees", employeesRoute);
app.use("/api/salons", salonsRoute);
app.use("/api", authRoutes);
app.use('/uploads', express.static('uploads'));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
//===========================Freelancer================================================================
import freelancerRoutes from './routes/freelancers.js';
app.use("/api/freelancers", freelancerRoutes);

import freelancerScheduleRoutes from "./routes/freelancer-schedule.js";
app.use("/api/freelancer-schedule", freelancerScheduleRoutes);

import publicFreelancerSchedule from "./routes/public/freelancer-schedule.js";
app.use("/api/public/freelancer-schedule", publicFreelancerSchedule);
//=============================Freelancer Payment========================================================
import paymentRoutes from './routes/payment.js';
app.use("/api/payment", paymentRoutes);

import appointmentInvoicesRoutes from "./routes/appointment-invoices.js";
app.use("/api/appointment-invoices", appointmentInvoicesRoutes);


//==============================Customer=======================================================================
import stylistsRoute from "./routes/stylists.js";
app.use("/api", stylistsRoute);

//============================Services======================================
import servicesRoute from './routes/services.js';
app.use("/api/services", servicesRoute);
import appointmentRoutes from "./routes/appointments.js";
app.use("/api/appointments", appointmentRoutes);

//============================Coins Analyzer======================================
// server.js (hoặc index.js, phần setup app):
import coinsRouter from "./routes/coins.js";
app.use("/api/coins", coinsRouter);

import workersRouter from "./routes/workers.js";
app.use("/api/workers", workersRouter);

import cryptoAssetsRoute from "./routes/crypto_assets.js";
app.use("/api/crypto-assets", cryptoAssetsRoute);

import marketRouter from "./routes/market.js";
app.use("/api/market", marketRouter);
//================================================================================

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
});

// Get Portfolio (authenticated)
app.get("/api/portfolio", verifyToken, async (req, res) => {
    const userId = req.user.uid;

    try {
        const result = await pool.query(
            `SELECT 
          coin_symbol, 
          SUM(CASE WHEN transaction_type = 'buy' THEN quantity ELSE -quantity END) AS total_quantity,
          SUM(CASE WHEN transaction_type = 'buy' THEN quantity * price ELSE 0 END) AS total_invested,
          SUM(CASE WHEN transaction_type = 'sell' THEN quantity * price ELSE 0 END) AS total_sold
        FROM transactions
        WHERE user_id = $1
        GROUP BY coin_symbol
        ORDER BY total_invested DESC;`,
            [userId]
        );

        const symbols = result.rows.map((coin) => coin.coin_symbol);

        // ✅ Nếu không có coin nào → dừng sớm
        if (!symbols || symbols.length === 0) {
            return res.json({ portfolio: [], totalInvested: 0, totalProfitLoss: 0 });
        }

        // ✅ Lấy reset date
        const resetDateResult = await pool.query(
            `SELECT coin_symbol, MAX(transaction_date) AS reset_date
         FROM transactions
         WHERE user_id = $1 AND is_reset_point = true AND coin_symbol = ANY($2)
         GROUP BY coin_symbol`,
            [userId, symbols]
        );

        const resetDates = {};
        resetDateResult.rows.forEach(row => {
            resetDates[row.coin_symbol] = row.reset_date;
        });

        // ✅ Lấy giá coin từ nội bộ API (giá ưu tiên Binance US)
        const priceUrl = `https://crypto-manager-backend.onrender.com/api/price?symbols=${symbols.join(",")}`;
        const priceRes = await axios.get(priceUrl);
        const coinPrices = priceRes.data;

        const portfolio = [];

        for (const symbol of symbols) {
            const resetDate = resetDates[symbol] || '1970-01-01';

            const { rows } = await pool.query(
                `SELECT 
            SUM(CASE WHEN transaction_type = 'buy' THEN quantity ELSE -quantity END) AS total_quantity,
            SUM(CASE WHEN transaction_type = 'buy' THEN quantity * price ELSE 0 END) AS total_invested,
            SUM(CASE WHEN transaction_type = 'sell' THEN quantity * price ELSE 0 END) AS total_sold
          FROM transactions
          WHERE user_id = $1 AND coin_symbol = $2 AND transaction_date >= $3`,
                [userId, symbol, resetDate]
            );

            const total_quantity = parseFloat(rows[0].total_quantity || 0);
            const total_invested = parseFloat(rows[0].total_invested || 0);
            const total_sold = parseFloat(rows[0].total_sold || 0);
            const current_price = coinPrices[symbol.toUpperCase()] || 0;
            const current_value = total_quantity * current_price;
            const profit_loss = current_value - (total_invested - total_sold);

            portfolio.push({
                coin_symbol: symbol,
                total_quantity,
                total_invested,
                total_sold,
                current_price,
                current_value,
                profit_loss,
            });
        }

        const totalInvested = portfolio.reduce((sum, c) => sum + c.total_invested, 0);
        const totalProfitLoss = portfolio.reduce((sum, c) => sum + c.profit_loss, 0);
        const txRes = await pool.query(
            `SELECT coin_symbol, transaction_type, quantity, price, transaction_date
         FROM transactions
         WHERE user_id = $1 AND coin_symbol = ANY($2::text[])
         ORDER BY transaction_date DESC`,
            [userId, symbols]
        );
        const transactions = txRes.rows;

        res.json({ portfolio, totalInvested, totalProfitLoss, transactions });
    } catch (error) {
        console.error("Error fetching portfolio:", error);
        res.status(500).json({ error: "Internal Server Error" });
    }
});


// Transactions CRUD
app.get("/api/transactions", verifyToken, async (req, res) => {
    const userId = req.user.uid;
    try {
        const result = await pool.query(
            "SELECT * FROM transactions WHERE user_id = $1 ORDER BY transaction_date DESC",
            [userId]
        );
        res.json(result.rows);
    } catch (error) {
        console.error("Error fetching transactions:", error);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

app.post("/api/transactions", verifyToken, async (req, res) => {
    const userId = req.user.uid;
    const { coin_symbol, quantity, price, transaction_type } = req.body;

    // 1. Lấy tổng số coin hiện có
    const result = await pool.query(
        `SELECT 
      COALESCE(SUM(CASE WHEN transaction_type = 'buy' THEN quantity ELSE -quantity END), 0) AS balance
     FROM transactions
     WHERE user_id = $1 AND coin_symbol = $2`,
        [userId, coin_symbol]
    );

    const currentBalance = parseFloat(result.rows[0].balance || 0);

    // 2. Kiểm tra nếu là BUY và đã từng bán hết → đánh dấu reset
    let isReset = false;
    if (transaction_type === 'buy' && currentBalance === 0) {
        isReset = true;
    }


    if (!coin_symbol || !quantity || !price || !transaction_type) {
        return res.status(400).json({ error: "Missing required fields" });
    }

    try {
        const insertResult = await pool.query(
            `INSERT INTO transactions (coin_symbol, quantity, price, transaction_type, user_id, is_reset_point) 
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
            [coin_symbol, quantity, price, transaction_type, userId, isReset]
        );

        res.status(201).json(insertResult.rows[0]);
    } catch (error) {
        console.error("Error adding transaction:", error);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

app.delete("/api/transactions/:id", verifyToken, async (req, res) => {
    const transactionId = req.params.id;
    const userId = req.user.uid;

    try {
        const result = await pool.query(
            "DELETE FROM transactions WHERE id = $1 AND user_id = $2 RETURNING *",
            [transactionId, userId]
        );

        if (result.rowCount === 0) {
            return res.status(404).json({ error: "Transaction not found or unauthorized" });
        }

        res.json({ message: "Transaction deleted successfully", deletedTransaction: result.rows[0] });
    } catch (error) {
        console.error("Error deleting transaction:", error);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

// Get Coin Prices
// ✅ Phiên bản backend - chính xác, không hardcode, đồng bộ với frontend
/* Đã thay bằng routes/price
async function getCoinPrices(symbols = []) {
    try {
        const res = await fetch("https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&per_page=250&page=1");
        if (!res.ok) throw new Error("Failed to fetch coin market data");

        const allMarkets = await res.json(); // [{ id, symbol, current_price, ... }]

        const priceMap = {};
        symbols.forEach(symbol => {
            const matches = allMarkets.filter(c => c.symbol.toLowerCase() === symbol.toLowerCase());

            if (matches.length > 0) {
                // Ưu tiên coin có market_cap lớn nhất
                const selected = matches.reduce((a, b) =>
                    (a.market_cap || 0) > (b.market_cap || 0) ? a : b
                );
                priceMap[symbol.toUpperCase()] = selected.current_price;
            }
        });

        return priceMap;
    } catch (error) {
        console.error("⚠️ getCoinPrices error (backend):", error);
        return {};
    }
}
*/
app.post("/api/user-alerts/init", async (req, res) => {
    const { user_id, email } = req.body;

    if (!user_id || !email) return res.status(400).json({ error: "Missing user_id or email" });

    try {
        await pool.query(
            `INSERT INTO user_alerts (user_id, email, last_profit_loss)
         VALUES ($1, $2, 0)
         ON CONFLICT (user_id) DO NOTHING`,
            [user_id, email]
        );

        res.json({ status: "created or already exists" });
    } catch (err) {
        console.error("Error inserting user_alerts:", err.message);
        res.status(500).json({ error: "Failed to insert" });
    }
});
app.get("/api/check-profit-alerts", async (req, res) => {
    try {
        const { rows: users } = await pool.query(`
            SELECT DISTINCT user_id FROM transactions
        `);

        const alertResults = [];

        for (const user of users) {
            const userId = user.user_id;

            const result = await pool.query(
                `SELECT 
                    coin_symbol, 
                    SUM(CASE WHEN transaction_type = 'buy' THEN quantity ELSE -quantity END) AS total_quantity,
                    SUM(CASE WHEN transaction_type = 'buy' THEN quantity * price ELSE 0 END) AS total_invested,
                    SUM(CASE WHEN transaction_type = 'sell' THEN quantity * price ELSE 0 END) AS total_sold
                FROM transactions
                WHERE user_id = $1
                GROUP BY coin_symbol
                ORDER BY total_invested DESC`,
                [userId]
            );

            const coinRows = result.rows.filter(r => parseFloat(r.total_quantity) > 0);
            if (coinRows.length === 0) continue;

            const symbols = coinRows.map(c => c.coin_symbol);
            if (symbols.length === 0) continue;

            let coinPrices = {};
            try {
                const priceUrl = `${process.env.BACKEND_URL || "https://crypto-manager-backend.onrender.com"}/api/price?symbols=${symbols.join(",")}`;
                const { data } = await axios.get(priceUrl);
                coinPrices = data;
            } catch (err) {
                console.error(`❌ Price fetch failed for user ${userId}:`, err.response?.data || err.message);
                continue; // skip user if price fetch fails
            }

            const portfolio = coinRows.map((coin) => {
                const currentPrice = coinPrices[coin.coin_symbol.toUpperCase()] || 0;
                const currentValue = coin.total_quantity * currentPrice;
                const profitLoss = currentValue - (coin.total_invested - coin.total_sold);

                return {
                    coin_symbol: coin.coin_symbol,
                    total_quantity: parseFloat(coin.total_quantity),
                    total_invested: parseFloat(coin.total_invested),
                    total_sold: parseFloat(coin.total_sold),
                    current_price: currentPrice,
                    current_value: currentValue,
                    profit_loss: profitLoss,
                };
            });

            const totalProfitLoss = portfolio.reduce((sum, coin) => sum + coin.profit_loss, 0);

            const { rows: alerts } = await pool.query(
                "SELECT last_profit_loss, alert_threshold, email FROM user_alerts WHERE user_id = $1",
                [userId]
            );

            const previous = alerts[0]?.last_profit_loss ?? 0;
            const threshold = alerts[0]?.alert_threshold ?? 5;
            const toEmail = alerts[0]?.email;

            const diff = totalProfitLoss - previous;
            const percentChange = previous !== 0 ? (diff / Math.abs(previous)) * 100 : 100;

            if (Math.abs(percentChange) >= threshold && toEmail) {
                try {
                    await sendAlertEmail(toEmail, totalProfitLoss, percentChange.toFixed(1), portfolio);

                    await pool.query(
                        `INSERT INTO user_alerts (user_id, last_profit_loss)
                        VALUES ($1, $2)
                        ON CONFLICT (user_id) DO UPDATE SET last_profit_loss = EXCLUDED.last_profit_loss`,
                        [userId, totalProfitLoss]
                    );

                    alertResults.push({ userId, email: toEmail, status: "sent" });
                } catch (err) {
                    console.warn(`⚠️ Skipping user ${userId} – email error:`, err.message);
                }
            }
        }

        res.json({ status: "done", alerts: alertResults });
    } catch (err) {
        console.error("❌ CRON alert error:", err.message);
        res.status(500).json({ error: "Internal Server Error" });
    }
});
//lấy alert settings của user
app.get("/api/user-alerts", verifyToken, async (req, res) => {
    const userId = req.user.uid;
    try {
        const { rows } = await pool.query(
            "SELECT email, alert_threshold FROM user_alerts WHERE user_id = $1",
            [userId]
        );
        res.json(rows[0] || {});
    } catch (err) {
        console.error("Error fetching user alert settings:", err.message);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

app.patch("/api/user-alerts", verifyToken, async (req, res) => {
    const userId = req.user.uid;
    const { alert_threshold } = req.body;

    if (!alert_threshold || isNaN(alert_threshold)) {
        return res.status(400).json({ error: "Invalid threshold" });
    }

    try {
        await pool.query(
            `INSERT INTO user_alerts (user_id, alert_threshold)
             VALUES ($1, $2)
             ON CONFLICT (user_id) DO UPDATE SET alert_threshold = EXCLUDED.alert_threshold`,
            [userId, alert_threshold]
        );
        res.json({ status: "updated" });
    } catch (err) {
        console.error("Error updating alert threshold:", err.message);
        res.status(500).json({ error: "Internal Server Error" });
    }
});
// Get all coin targets for user
app.get("/api/coin-targets", verifyToken, async (req, res) => {
    const userId = req.user.uid;
    try {
        const { rows } = await pool.query(
            `SELECT coin_symbol, target_percent FROM user_coin_targets WHERE user_id = $1`,
            [userId]
        );
        res.json(rows);
    } catch (err) {
        console.error("Error fetching coin targets:", err.message);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

// Update target
app.patch("/api/coin-targets/:symbol", verifyToken, async (req, res) => {
    const userId = req.user.uid;
    const symbol = req.params.symbol;
    const { target_percent } = req.body;

    if (target_percent === undefined || isNaN(target_percent)) {
        return res.status(400).json({ error: "Invalid target_percent" });
    }

    try {
        await pool.query(
            `INSERT INTO user_coin_targets (user_id, coin_symbol, target_percent)
             VALUES ($1, $2, $3)
             ON CONFLICT (user_id, coin_symbol) 
             DO UPDATE SET target_percent = EXCLUDED.target_percent`,
            [userId, symbol.toUpperCase(), target_percent]
        );
        res.json({ status: "updated" });
    } catch (err) {
        console.error("Error updating coin target:", err.message);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

// ======================= Cleanup function =======================
async function pruneOnchainTransfers(retentionDays = ONCHAIN_RETENTION_DAYS, batchSize = ONCHAIN_CLEANUP_BATCH) {
    console.log(`[cleanup] Start: retention=${retentionDays}d, batch=${batchSize}`);
    let total = 0;

    while (true) {
        // Xóa theo lô để lock ngắn, tránh đứng hệ thống
        const { rows } = await pool.query(
            `
      WITH doomed AS (
        SELECT ctid
        FROM public.onchain_transfers
        WHERE block_time < now() - ($1 || ' days')::interval
        LIMIT $2
      ),
      del AS (
        DELETE FROM public.onchain_transfers t
        USING doomed d
        WHERE t.ctid = d.ctid
        RETURNING 1
      )
      SELECT COUNT(*)::int AS cnt FROM del;
      `,
            [retentionDays, batchSize]
        );

        const n = rows?.[0]?.cnt || 0;
        if (n === 0) break;
        total += n;
        console.log(`[cleanup] deleted ${n} rows... (total=${total})`);
    }

    // Phân tích lại thống kê để planner chọn index tốt
    await pool.query(`ANALYZE public.onchain_transfers;`);
    console.log(`[cleanup] Done. Total deleted: ${total}`);
    return total;
}


//============================Coins Analyzer Cron==============================================================


if (process.env.ENABLE_INTERNAL_CRON === "true") {
    // Chạy “warmup” ngay khi server start để có dữ liệu giá sớm
    (async () => {
        try { await runPriceWorker(); } catch (e) { console.error(e); }
        try { await runOnchainWorker(); } catch (e) { console.error(e); } // không có API key sẽ skip
        try { await runNewsWorker(); } catch (e) { console.error(e); }    // không có API key sẽ skip
    })();

    // Lịch định kỳ
    cron.schedule("*/5 * * * *", async () => {
        console.log("CRON: fetching price & on-chain ...");
        try { await runPriceWorker(); } catch (e) { console.error(e); }
        try { await runOnchainWorker(); } catch (e) { console.error(e); }
    });

    cron.schedule("*/15 * * * *", async () => {
        console.log("CRON: fetching news ...");
        try { await runNewsWorker(); } catch (e) { console.error(e); }
    });

    // Cleanup onchain_transfers hằng ngày lúc 03:20 (theo CLEANUP_CRON_TZ)
    cron.schedule(
        "20 3 * * *",
        async () => {
            console.log("CRON: pruning onchain_transfers ...");
            try {
                const deleted = await pruneOnchainTransfers();
                console.log(`CRON: pruned ${deleted} rows older than ${ONCHAIN_RETENTION_DAYS}d`);
            } catch (e) {
                console.error("CRON: cleanup error:", e);
            }
        },
        { timezone: CLEANUP_CRON_TZ }
    );

    console.log("✅ Internal cron enabled");
}

//============================Coins Analyzer Functions======================================

// Health check
app.get("/", (req, res) => {
    res.send("Crypto Manager API is running...");
});

// 🔐 Tùy bạn: có thể bọc verifyToken/admin guard trước khi mở public
app.post("/api/admin/cleanup-onchain", async (req, res) => {
    try {
        const days = Number(req.query.days || ONCHAIN_RETENTION_DAYS);
        const batch = Number(req.query.batch || ONCHAIN_CLEANUP_BATCH);
        const deleted = await pruneOnchainTransfers(days, batch);
        res.json({ ok: true, deleted, retention_days: days, batch });
    } catch (e) {
        console.error("manual cleanup error:", e);
        res.status(500).json({ ok: false, error: e.message });
    }
});


app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});
