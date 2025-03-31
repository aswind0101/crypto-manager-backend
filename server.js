
import express from "express";
import cors from "cors";
import dotenv from "dotenv";

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
        const coinPrices = await getCoinPrices(symbols);
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
async function getCoinPrices(symbols = [], retryCount = 0) {
    try {
        // Gọi danh sách coin 1 lần để map symbol → id
        const listRes = await fetch("https://api.coingecko.com/api/v3/coins/list");
        if (!listRes.ok) throw new Error("Failed to fetch coin list");

        const coinList = await listRes.json(); // [{ id, symbol, name }]

        const symbolToId = {};
        symbols.forEach(symbol => {
            const match = coinList.find(c => c.symbol.toLowerCase() === symbol.toLowerCase());
            if (match) {
                symbolToId[symbol.toUpperCase()] = match.id;
            }
        });

        const ids = Object.values(symbolToId);
        if (ids.length === 0) return {};

        const priceUrl = `https://api.coingecko.com/api/v3/simple/price?ids=${ids.join(",")}&vs_currencies=usd`;
        const priceRes = await fetch(priceUrl);
        if (!priceRes.ok) throw new Error(`CoinGecko API error (${priceRes.status}): ${priceRes.statusText}`);

        const data = await priceRes.json(); // { bitcoin: { usd: 70000 }, ... }

        const priceMap = {};
        for (const [symbol, id] of Object.entries(symbolToId)) {
            priceMap[symbol] = data[id]?.usd || 0;
        }

        return priceMap;
    } catch (error) {
        console.error(`⚠️ getCoinPrices error [Attempt ${retryCount + 1}]:`, error.message || error);

        if (retryCount < 2) {
            const waitTime = 1000 * (retryCount + 1); // Retry: 1s → 2s
            await new Promise(resolve => setTimeout(resolve, waitTime));
            return getCoinPrices(symbols, retryCount + 1);
        }

        return {};
    }
}




// Health check
app.get("/", (req, res) => {
    res.send("Crypto Manager API is running...");
});

app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});
