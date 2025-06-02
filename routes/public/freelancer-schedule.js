import express from "express";
import pkg from "pg";
const { Pool } = pkg;

const router = express.Router();
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ✅ GET /api/public/freelancer-schedule?freelancer_id=123
router.get("/", async (req, res) => {
  const { freelancer_id } = req.query;

  if (!freelancer_id) {
    return res.status(400).json({ error: "Missing freelancer_id" });
  }

  try {
    const result = await pool.query(
      `SELECT weekday, start_time, end_time
       FROM freelancer_schedule
       WHERE freelancer_id = $1
       ORDER BY weekday ASC`,
      [freelancer_id]
    );

    res.json(result.rows);
  } catch (err) {
    console.error("❌ Error fetching public freelancer schedule:", err.message);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

export default router;
