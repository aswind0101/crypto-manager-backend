import express from "express";
import verifyToken from "../middleware/verifyToken.js";
import pkg from "pg";
const { Pool } = pkg;

const router = express.Router();
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
});

// GET: Lấy danh sách các khoản nợ
router.get("/", verifyToken, async (req, res) => {
    const userId = req.user.uid;
    try {
        const result = await pool.query(`
      SELECT d.*, l.name AS lender_name,
       COALESCE(SUM(p.amount_paid), 0) AS total_paid,
       (d.total_amount - COALESCE(SUM(p.amount_paid), 0)) AS remaining
FROM debts d
LEFT JOIN lenders l ON d.lender_id = l.id
LEFT JOIN debt_payments p ON d.id = p.debt_id
WHERE d.user_id = $1
GROUP BY d.id, l.name
ORDER BY d.created_at DESC

    `, [userId]);
        res.json(result.rows);
    } catch (err) {
        console.error("Error fetching debts:", err.message);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

// POST: Thêm khoản nợ mới
router.post("/", verifyToken, async (req, res) => {
    const userId = req.user.uid;
    const { lender_id, total_amount, note, created_at } = req.body;
  
    if (!lender_id || !total_amount) {
      return res.status(400).json({ error: "Missing lender ID or amount" });
    }
    console.log("➡️ Add debt", {
        userId,
        lender_id,
        total_amount,
        note,
        created_at
      });
      
    try {
      const result = await pool.query(
        `INSERT INTO debts (user_id, lender_id, total_amount, note, created_at)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [userId, lender_id, total_amount, note, created_at || new Date()]
      );
      res.status(201).json(result.rows[0]);
    } catch (err) {
        console.error("❌ Error adding debt:", err); // log toàn bộ lỗi
        res.status(500).json({ error: "Internal Server Error" });
    }
  });  

export default router;
