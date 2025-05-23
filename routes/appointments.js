// 📁 backend/routes/appointments.js
import express from "express";
import verifyToken from "../middleware/verifyToken.js";
import pkg from "pg";
const { Pool } = pkg;

const router = express.Router();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ✅ POST: Khách tạo hẹn mới
router.post("/", verifyToken, async (req, res) => {
  const { uid } = req.user;
  const {
    stylist_id,
    salon_id,
    service_ids,
    appointment_date,
    duration_minutes,
    note,
  } = req.body;

  if (!stylist_id || !salon_id || !service_ids || !appointment_date) {
    return res.status(400).json({ error: "Missing required fields." });
  }

  try {
    const result = await pool.query(
      `INSERT INTO appointments (customer_uid, stylist_id, salon_id, service_ids, appointment_date, duration_minutes, note)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [uid, stylist_id, salon_id, service_ids, appointment_date, duration_minutes, note || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error("❌ Error creating appointment:", err.message);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// ✅ GET: Khách lấy danh sách hẹn của mình
router.get("/me", verifyToken, async (req, res) => {
  const { uid } = req.user;
  try {
    const result = await pool.query(
      `SELECT * FROM appointments WHERE customer_uid = $1 ORDER BY appointment_date DESC`,
      [uid]
    );
    res.json(result.rows);
  } catch (err) {
    console.error("❌ Error fetching appointments:", err.message);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// ✅ GET: Stylist lấy lịch hẹn của mình
router.get("/freelancer", verifyToken, async (req, res) => {
  const { uid } = req.user;
  try {
    const stylist = await pool.query(
      `SELECT id FROM freelancers WHERE firebase_uid = $1`,
      [uid]
    );
    if (stylist.rows.length === 0) return res.status(403).json({ error: "Stylist not found" });

    const stylistId = stylist.rows[0].id;
    const result = await pool.query(
      `SELECT * FROM appointments WHERE stylist_id = $1 ORDER BY appointment_date ASC`,
      [stylistId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error("❌ Error fetching stylist appointments:", err.message);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// ✅ PATCH: Cập nhật trạng thái lịch hẹn
router.patch("/:id", verifyToken, async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  if (!["pending", "confirmed", "completed", "cancelled"].includes(status)) {
    return res.status(400).json({ error: "Invalid status value" });
  }

  try {
    const result = await pool.query(
      `UPDATE appointments SET status = $1 WHERE id = $2 RETURNING *`,
      [status, id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: "Appointment not found" });
    res.json(result.rows[0]);
  } catch (err) {
    console.error("❌ Error updating appointment status:", err.message);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

export default router;
