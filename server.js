const express = require("express");
const cors = require("cors");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 5000;


app.use(cors());
app.use(express.json());

const { Pool } = require("pg");

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
});

// API lấy danh sách giao dịch
app.get("/api/transactions", async (req, res) => {
    try {
        const result = await pool.query("SELECT * FROM transactions ORDER BY transaction_date DESC");
        res.json(result.rows);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

// Test API
app.get("/", (req, res) => {
    res.send("Crypto Manager API is running...");
});

// API thêm giao dịch mới
app.post("/api/transactions", async (req, res) => {
    const { coin_symbol, quantity, price, transaction_type } = req.body;

    if (!coin_symbol || !quantity || !price || !transaction_type) {
        return res.status(400).json({ error: "Missing required fields" });
    }

    try {
        const result = await pool.query(
            `INSERT INTO transactions (coin_symbol, quantity, price, transaction_type) VALUES ($1, $2, $3, $4) RETURNING *`,
            [coin_symbol, quantity, price, transaction_type]
        );
        res.status(201).json(result.rows[0]);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

// API xoá giao dịch theo ID
app.delete("/api/transactions/:id", async (req, res) => {
    const transactionId = req.params.id;

    try {
        const result = await pool.query("DELETE FROM transactions WHERE id = $1 RETURNING *", [transactionId]);

        if (result.rowCount === 0) {
            return res.status(404).json({ error: "Transaction not found" });
        }

        res.json({ message: "Transaction deleted successfully", deletedTransaction: result.rows[0] });
    } catch (error) {
        console.error("Error deleting transaction:", error);
        res.status(500).json({ error: "Internal Server Error" });
    }
});



// Hàm lấy giá của tất cả các coin từ CoinGecko
async function getCoinPrices() {
    try {
        console.log("Fetching all coin prices from CoinGecko...");

        const response = await fetch("https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd");
        const data = await response.json();

        console.log("Received data from CoinGecko:", data.slice(0, 5)); // In ra 5 coin đầu tiên để kiểm tra

        // Nếu data rỗng, báo lỗi
        if (!data || data.length === 0) {
            console.error("Error: No coin data received from CoinGecko");
            return {};
        }

        // Mapping symbol -> giá hiện tại
        let priceMap = {};
        data.forEach(coin => {
            priceMap[coin.symbol.toUpperCase()] = coin.current_price;
        });

        console.log("Mapped coin prices:", priceMap); // Debug giá coin

        return priceMap;
    } catch (error) {
        console.error("Error fetching all coin prices:", error);
        return {};
    }
}


// API lấy danh mục đầu tư + lợi nhuận dựa trên giá hiện tại
app.get("/api/portfolio", async (req, res) => {
    try {
        // Lấy danh sách các loại coin trong danh mục đầu tư
        const result = await pool.query(`
        SELECT 
          coin_symbol, 
          SUM(CASE WHEN transaction_type = 'buy' THEN quantity ELSE -quantity END) AS total_quantity,
          SUM(CASE WHEN transaction_type = 'buy' THEN quantity * price ELSE 0 END) AS total_invested,
          SUM(CASE WHEN transaction_type = 'sell' THEN quantity * price ELSE 0 END) AS total_sold
        FROM transactions
        GROUP BY coin_symbol
        ORDER BY total_invested DESC;
      `);

        // Nếu không có dữ liệu, trả về danh sách trống
        if (result.rows.length === 0) {
            return res.json({ portfolio: [], totalInvested: 0, totalProfitLoss: 0 });
        }

        // Lấy giá của tất cả các coin từ CoinGecko
        const coinPrices = await getCoinPrices();

        // Xử lý dữ liệu danh mục
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
                profit_loss: profitLoss
            };
        });

        // Tính tổng đầu tư & tổng lợi nhuận
        const totalInvested = portfolio.reduce((sum, coin) => sum + coin.total_invested, 0);
        const totalProfitLoss = portfolio.reduce((sum, coin) => sum + coin.profit_loss, 0);

        res.json({ portfolio, totalInvested, totalProfitLoss });
    } catch (error) {
        console.error("Error fetching portfolio summary:", error);
        res.status(500).json({ error: "Internal Server Error" });
    }
});



app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server is running on http://192.168.1.58:${PORT}`);
});

