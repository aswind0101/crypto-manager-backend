// backend/routes/coinList.js
import express from "express";
import pkg from "pg";
const { Pool } = pkg;

const router = express.Router();

// 🔁 Dùng cùng cấu hình như server.js
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
});

router.get("/", async (req, res) => {
    try {
        const result = await pool.query("SELECT id, symbol, name, updated_at FROM coins ORDER BY name ASC");
        res.json(result.rows); // [{ id, symbol, name }]
    } catch (err) {
        console.error("❌ Error fetching coinList:", err);
        res.status(500).json({ error: "Failed to fetch coin list" });
    }
});

export default router;
