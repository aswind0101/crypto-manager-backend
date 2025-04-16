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
// POST /api/debt-payments/by-lender
router.post("/by-lender", verifyToken, async (req, res) => {
  const userId = req.user.uid;
  const { lender_id, amount_paid, note } = req.body;

  if (!lender_id || !amount_paid) {
    return res.status(400).json({ error: "Missing lender_id or amount_paid" });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // Lấy danh sách các khoản nợ chưa trả hết
    const debtsRes = await client.query(
      `SELECT d.id, d.total_amount, COALESCE(SUM(p.amount_paid), 0) AS paid
       FROM debts d
       LEFT JOIN debt_payments p ON d.id = p.debt_id
       WHERE d.lender_id = $1 AND d.user_id = $2
       GROUP BY d.id, d.total_amount
       HAVING (d.total_amount - COALESCE(SUM(p.amount_paid), 0)) > 0
       ORDER BY d.created_at ASC`,
      [lender_id, userId]
    );

    let remainingToPay = parseFloat(amount_paid);
    const payments = [];

    for (const debt of debtsRes.rows) {
      if (remainingToPay <= 0) break;

      const remaining = parseFloat(debt.total_amount) - parseFloat(debt.paid);
      const payNow = Math.min(remaining, remainingToPay);

      const result = await client.query(
        `INSERT INTO debt_payments (debt_id, amount_paid, note)
         VALUES ($1, $2, $3) RETURNING *`,
        [debt.id, payNow, note]
      );

      payments.push(result.rows[0]);
      remainingToPay -= payNow;
    }

    await client.query("COMMIT");
    res.status(201).json({ success: true, payments });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("💥 Error in by-lender payment:", err.message);
    res.status(500).json({ error: "Internal Server Error" });
  } finally {
    client.release();
  }
});
// GET: Lấy danh sách các khoản trả nợ của user (dùng để hiển thị trong chi tiết)
router.get("/", verifyToken, async (req, res) => {
  const userId = req.user.uid;

  try {
    const result = await pool.query(`
      SELECT p.*
      FROM debt_payments p
      INNER JOIN debts d ON p.debt_id = d.id
      WHERE d.user_id = $1
      ORDER BY p.created_at ASC
    `, [userId]);

    res.json(result.rows);
  } catch (err) {
    console.error("❌ Error fetching debt payments:", err.message);
    res.status(500).json({ error: "Internal Server Error" });
  }
});


export default router;
