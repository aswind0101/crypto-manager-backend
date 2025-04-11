
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import axios from "axios";
import coinListRoute from './routes/coinList.js';
import { sendAlertEmail } from "./utils/sendAlertEmail.js";



import pkg from "pg";
const { Pool } = pkg; // ✅ Chính xác

import verifyToken from "./middleware/verifyToken.js"; // nhớ thêm .js

dotenv.config({ path: "./backend/.env" }); // hoặc ".env" nếu bạn dùng file đó
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

        //const coinPrices = await getCoinPrices();Thay thế dòng này bằng:
        const symbols = result.rows.map((coin) => coin.coin_symbol);
        // Gọi nội bộ API backend để lấy giá từ price.js

        const priceUrl = `https://crypto-manager-backend.onrender.com/api/price?symbols=${symbols.join(",")}`;
        //const priceUrl = `http://192.168.1.58:5000/api/price?symbols=${symbols.join(",")}`;
        const priceRes = await axios.get(priceUrl);
        const coinPrices = priceRes.data; // { BTC: 72000, NEAR: 7.3, ... }

        const portfolio = result.rows.map((coin) => {
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

        const totalInvested = portfolio.reduce((sum, coin) => sum + coin.total_invested, 0);
        const totalProfitLoss = portfolio.reduce((sum, coin) => sum + coin.profit_loss, 0);
        // === Check for alert ==================================================================
        const alertResult = await pool.query(
            "SELECT last_profit_loss, alert_threshold FROM user_alerts WHERE user_id = $1",
            [userId]
        );

        const current = totalProfitLoss;
        const previous = alertResult.rows[0]?.last_profit_loss || 0;
        const threshold = alertResult.rows[0]?.alert_threshold || 5;

        const diff = Math.abs(current - previous);
        const percentChange = Math.abs(previous) > 0 ? (diff / Math.abs(previous)) * 100 : 100;

        if (percentChange >= threshold) {
            // 👇 Gửi email cảnh báo
            await sendAlertEmail(req.user.email, current, percentChange.toFixed(1), portfolio);

            // 👇 Lưu lại giá trị mới
            await pool.query(
                `INSERT INTO user_alerts (user_id, last_profit_loss)
       VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE SET last_profit_loss = EXCLUDED.last_profit_loss`,
                [userId, current]
            );
        }

        // ======================================================================================
        res.json({ portfolio, totalInvested, totalProfitLoss });
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

    if (!coin_symbol || !quantity || !price || !transaction_type) {
        return res.status(400).json({ error: "Missing required fields" });
    }

    try {
        const result = await pool.query(
            `INSERT INTO transactions (coin_symbol, quantity, price, transaction_type, user_id) 
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
            [coin_symbol, quantity, price, transaction_type, userId]
        );
        res.status(201).json(result.rows[0]);
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

            // Lấy portfolio
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

            if (!result.rows || result.rows.length === 0) continue;

            const symbols = result.rows.map(c => c.coin_symbol);
            const priceUrl = `https://crypto-manager-backend.onrender.com/api/price?symbols=${symbols.join(",")}`;
            const { data: coinPrices } = await axios.get(priceUrl);

            const portfolio = result.rows.map((coin) => {
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

            // Lấy dữ liệu alert
            const { rows: alerts } = await pool.query(
                "SELECT last_profit_loss, alert_threshold FROM user_alerts WHERE user_id = $1",
                [userId]
            );

            const previous = alerts[0]?.last_profit_loss ?? 0;
            const threshold = alerts[0]?.alert_threshold ?? 5;
            const diff = Math.abs(totalProfitLoss - previous);
            const percentChange = Math.abs(previous) > 0 ? (diff / Math.abs(previous)) * 100 : 100;

            if (percentChange >= threshold) {
                try {
                    // ✅ Lấy email từ Firebase
                    // ✅ Lấy email từ bảng user_alerts
                    const emailQuery = await pool.query("SELECT email FROM user_alerts WHERE user_id = $1", [userId]);
                    const toEmail = emailQuery.rows[0]?.email;

                    if (toEmail) {
                        await sendAlertEmail(toEmail, totalProfitLoss, percentChange.toFixed(1), portfolio);

                        await pool.query(
                            `INSERT INTO user_alerts (user_id, last_profit_loss)
                 VALUES ($1, $2)
                 ON CONFLICT (user_id) DO UPDATE SET last_profit_loss = EXCLUDED.last_profit_loss`,
                            [userId, totalProfitLoss]
                        );

                        alertResults.push({ userId, email: toEmail, status: "sent" });
                    }
                } catch (err) {
                    console.warn(`⚠️ Skipping user ${userId} – Firebase error:`, err.message);
                }
            }
        }

        res.json({ status: "done", alerts: alertResults });
    } catch (err) {
        console.error("❌ CRON alert error:", err.message);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

// Health check
app.get("/", (req, res) => {
    res.send("Crypto Manager API is running...");
});

app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});
