import express from "express";
import verifyToken from "../middleware/verifyToken.js";
import pkg from "pg";
const { Pool } = pkg;

const router = express.Router();
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// GET: Lấy danh sách category của user
router.get("/", verifyToken, async (req, res) => {
  const userId = req.user.uid;
  try {
    const result = await pool.query(
      "SELECT * FROM categories WHERE user_id = $1 ORDER BY name ASC",
      [userId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error("Error fetching categories:", err.message);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// POST: Thêm category mới
router.post("/", verifyToken, async (req, res) => {
  const userId = req.user.uid;
  const { name, type } = req.body;

  if (!name || !type || !["income", "expense"].includes(type)) {
    return res.status(400).json({ error: "Invalid input" });
  }

  try {
    const result = await pool.query(
      `INSERT INTO categories (user_id, name, type) 
       VALUES ($1, $2, $3) RETURNING *`,
      [userId, name.trim(), type]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error("Error adding category:", err.message);
    res.status(500).json({ error: "Internal Server Error" });
  }
});
router.delete("/:id", verifyToken, async (req, res) => {
  const userId = req.user.uid;
  const categoryId = req.params.id;

  try {
    // 1. Kiểm tra nếu category đang được dùng trong bảng expenses
    const usedCheck = await pool.query(
      `SELECT COUNT(*) FROM expenses WHERE user_id = $1 AND category = $2`,
      [userId, categoryId]
    );

    const count = parseInt(usedCheck.rows[0].count);
    if (count > 0) {
      return res.status(400).json({ error: "Category is in use and cannot be deleted." });
    }

    // 2. Nếu không dùng → xoá
    await pool.query(`DELETE FROM categories WHERE id = $1 AND user_id = $2`, [categoryId, userId]);
    res.json({ status: "deleted" });
  } catch (err) {
    console.error("❌ Delete category error:", err.message);
    res.status(500).json({ error: "Internal Server Error" });
  }
});


export default router;
