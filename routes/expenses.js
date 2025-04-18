import express from "express";
import verifyToken from "../middleware/verifyToken.js";
import pkg from "pg";
const { Pool } = pkg;

const router = express.Router();
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// Lấy danh sách thu chi
router.get("/", verifyToken, async (req, res) => {
  const userId = req.user.uid;
  try {
    const result = await pool.query(
      "SELECT * FROM expenses WHERE user_id = $1 ORDER BY expense_date DESC",
      [userId]
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// Thêm thu/chi mới
router.post("/", verifyToken, async (req, res) => {
  const userId = req.user.uid;
  const { amount, category, type, description, expense_date } = req.body;

  if (!amount || !category || !type) {
    return res.status(400).json({ error: "Missing fields" });
  }

  try {
    const result = await pool.query(
      `INSERT INTO expenses (user_id, amount, category, type, description, expense_date )
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
       [userId, amount, category, type, description, expense_date || new Date()]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: "Internal Server Error" });
  }
});
router.delete("/:id", verifyToken, async (req, res) => {
  const userId = req.user.uid;
  const { id } = req.params;

  try {
    const result = await pool.query(
      `DELETE FROM expenses WHERE id = $1 AND user_id = $2 RETURNING *`,
      [id, userId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Expense not found or unauthorized" });
    }

    res.json({ success: true });
  } catch (err) {
    console.error("❌ Delete expense error:", err.message);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

export default router;
