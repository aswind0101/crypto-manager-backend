import express from "express";
import verifyToken from "../middleware/verifyToken.js";
import pkg from "pg";
const { Pool } = pkg;

const router = express.Router();
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// POST: Ghi nhận trả nợ
router.post("/", verifyToken, async (req, res) => {
  const userId = req.user.uid;
  const { debt_id, amount_paid, note } = req.body;

  if (!debt_id || !amount_paid) {
    return res.status(400).json({ error: "Missing debt_id or amount_paid" });
  }

  try {
    const result = await pool.query(`
      INSERT INTO debt_payments (debt_id, amount_paid, note)
      VALUES ($1, $2, $3) RETURNING *
    `, [debt_id, amount_paid, note]);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error("Error recording payment:", err.message);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

export default router;
