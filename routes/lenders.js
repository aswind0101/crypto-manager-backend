import express from "express";
import verifyToken from "../middleware/verifyToken.js";
import pkg from "pg";
const { Pool } = pkg;

const router = express.Router();
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// GET: Lấy danh sách lenders của user
router.get("/", verifyToken, async (req, res) => {
  const userId = req.user.uid;
  try {
    const result = await pool.query(
      `SELECT * FROM lenders WHERE user_id = $1 ORDER BY created_at DESC`,
      [userId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error("Error fetching lenders:", err.message);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// POST: Thêm lender mới
router.post("/", verifyToken, async (req, res) => {
  const userId = req.user.uid;
  const { name, note } = req.body;

  if (!name) {
    return res.status(400).json({ error: "Lender name is required" });
  }

  try {
    const result = await pool.query(
      `INSERT INTO lenders (user_id, name, note)
       VALUES ($1, $2, $3) RETURNING *`,
      [userId, name.trim(), note || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error("Error adding lender:", err.message);
    res.status(500).json({ error: "Internal Server Error" });
  }
});
// DELETE: Xoá lender nếu không có khoản nợ liên quan
router.delete("/:id", verifyToken, async (req, res) => {
  const userId = req.user.uid;
  const lenderId = req.params.id;

  try {
    // ✅ Kiểm tra xem lender này có khoản nợ nào không
    const check = await pool.query(
      `SELECT COUNT(*) FROM debts WHERE user_id = $1 AND lender_id = $2`,
      [userId, lenderId]
    );

    if (parseInt(check.rows[0].count) > 0) {
      return res.status(400).json({ error: "This lender has associated debts and cannot be deleted." });
    }

    // ✅ Nếu không có khoản nợ → cho xoá
    const result = await pool.query(
      `DELETE FROM lenders WHERE id = $1 AND user_id = $2 RETURNING *`,
      [lenderId, userId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Lender not found or unauthorized." });
    }

    res.json({ status: "deleted" });
  } catch (err) {
    console.error("❌ Error deleting lender:", err.message);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

export default router;
