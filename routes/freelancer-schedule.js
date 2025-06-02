import express from "express";
import pkg from "pg";
import verifyToken from "../middleware/verifyToken.js";

const router = express.Router();
const { Pool } = pkg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// 🟢 GET: lấy lịch làm việc của freelancer hiện tại
router.get("/", verifyToken, async (req, res) => {
  const uid = req.user.uid;

  try {
    const freelancerRes = await pool.query(
      "SELECT id FROM freelancers WHERE firebase_uid = $1",
      [uid]
    );
    if (freelancerRes.rowCount === 0) return res.status(404).json({ error: "Freelancer not found" });

    const freelancerId = freelancerRes.rows[0].id;

    const result = await pool.query(
      "SELECT * FROM freelancer_schedule WHERE freelancer_id = $1 ORDER BY weekday ASC, start_time ASC",
      [freelancerId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error("❌ GET schedule error:", err.message);
    res.status(500).json({ error: "Internal server error" });
  }
});
// ✅ Public GET schedule by freelancer_id (no auth required)
router.get("/public", async (req, res) => {
  const { freelancer_id } = req.query;

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
    console.error("❌ Public GET error:", err.message);
    res.status(500).json({ error: "Internal server error" });
  }
});

// 🔵 POST: tạo hoặc cập nhật 1 ngày làm việc (theo weekday)
router.post("/", verifyToken, async (req, res) => {
  const uid = req.user.uid;
  const { weekday, start_time, end_time } = req.body;

  if (![0, 1, 2, 3, 4, 5, 6].includes(weekday)) return res.status(400).json({ error: "Invalid weekday" });

  try {
    const freelancerRes = await pool.query(
      "SELECT id FROM freelancers WHERE firebase_uid = $1",
      [uid]
    );
    if (freelancerRes.rowCount === 0) return res.status(404).json({ error: "Freelancer not found" });

    const freelancerId = freelancerRes.rows[0].id;

    // Xoá lịch cũ nếu trùng weekday
    await pool.query(
      "DELETE FROM freelancer_schedule WHERE freelancer_id = $1 AND weekday = $2",
      [freelancerId, weekday]
    );

    // Thêm lịch mới
    await pool.query(
      "INSERT INTO freelancer_schedule (freelancer_id, weekday, start_time, end_time) VALUES ($1, $2, $3, $4)",
      [freelancerId, weekday, start_time, end_time]
    );

    res.json({ message: "Schedule updated" });
  } catch (err) {
    console.error("❌ POST schedule error:", err.message);
    res.status(500).json({ error: "Internal server error" });
  }
});

// 🔴 DELETE: xoá lịch theo id
router.delete("/:id", verifyToken, async (req, res) => {
  const uid = req.user.uid;
  const id = req.params.id;

  try {
    const freelancerRes = await pool.query(
      "SELECT id FROM freelancers WHERE firebase_uid = $1",
      [uid]
    );
    if (freelancerRes.rowCount === 0) return res.status(404).json({ error: "Freelancer not found" });

    const freelancerId = freelancerRes.rows[0].id;

    const result = await pool.query(
      "DELETE FROM freelancer_schedule WHERE id = $1 AND freelancer_id = $2",
      [id, freelancerId]
    );

    if (result.rowCount === 0) return res.status(404).json({ error: "Not found" });
    res.json({ message: "Schedule deleted" });
  } catch (err) {
    console.error("❌ DELETE schedule error:", err.message);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
