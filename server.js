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
         WHERE user_id = $1
         ORDER BY transaction_date DESC
         LIMIT 50`,
        [userId]
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

// Health check
app.get("/", (req, res) => {
    res.send("Crypto Manager API is running...");
});

app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});