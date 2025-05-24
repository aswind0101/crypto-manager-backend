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
// ✅ GET: Trả về danh sách lịch hẹn của stylist trong 1 ngày
router.get("/availability", async (req, res) => {
  const { stylist_id, date } = req.query;

  if (!stylist_id || !date) {
    return res.status(400).json({ error: "Missing stylist_id or date." });
  }

  try {
    // Tính khoảng thời gian từ 00:00 đến 23:59 ngày đó
    const dayStart = new Date(`${date}T00:00:00`);
    const dayEnd = new Date(`${date}T23:59:59`);

    const result = await pool.query(
      `SELECT 
         appointment_date, 
         COALESCE(duration_minutes, 30) AS duration_minutes
       FROM appointments
       WHERE stylist_id = $1
         AND appointment_date BETWEEN $2 AND $3
         AND status IN ('pending', 'confirmed')`,
      [stylist_id, dayStart, dayEnd]
    );

    res.json(result.rows); // Trả về danh sách các khung giờ đã được đặt
  } catch (err) {
    console.error("❌ Error fetching availability:", err.message);
    res.status(500).json({ error: "Internal Server Error" });
  }
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
  // ✅ Kiểm tra stylist đã có lịch bị trùng không
  const newStart = new Date(appointment_date);
  const newEnd = new Date(newStart.getTime() + duration_minutes * 60000);

  const conflictCheck = await pool.query(
    `SELECT 1 FROM appointments 
   WHERE stylist_id = $1 
     AND status IN ('pending', 'confirmed') 
     AND (
       appointment_date < $3
       AND appointment_date + INTERVAL '1 minute' * COALESCE(duration_minutes, 30) > $2
     )`,
    [stylist_id, newStart, newEnd]
  );

  if (conflictCheck.rows.length > 0) {
    return res.status(409).json({ error: "❌ Stylist already has an appointment in this time range." });
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
    const result = await pool.query(`
  SELECT 
    a.id,
    a.appointment_date,
    a.duration_minutes,
    a.note,
    a.status,
    f.name AS stylist_name,
    f.avatar_url AS stylist_avatar,
    f.specialization AS stylist_specialization,
    s.name AS salon_name,
    ARRAY(
      SELECT json_build_object('id', ss.id, 'name', ss.name, 'price', ss.price, 'duration', ss.duration_minutes)
      FROM salon_services ss
      WHERE ss.id = ANY(a.service_ids)
    ) AS services
  FROM appointments a
  JOIN freelancers f ON a.stylist_id = f.id
  JOIN salons s ON a.salon_id = s.id
  WHERE a.customer_uid = $1
  ORDER BY a.appointment_date DESC
`, [uid]);

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
// ✅ DELETE: Khách huỷ lịch nếu chưa tới giờ
router.delete("/:id", verifyToken, async (req, res) => {
  const { uid } = req.user;
  const { id } = req.params;

  try {
    const check = await pool.query(`
      SELECT appointment_date, status,
             appointment_date > (NOW() AT TIME ZONE 'UTC' AT TIME ZONE 'America/Los_Angeles') AS is_future
      FROM appointments
      WHERE id = $1 AND customer_uid = $2
    `, [id, uid]);

    if (check.rows.length === 0) {
      return res.status(404).json({ error: "Appointment not found" });
    }

    const { status, is_future } = check.rows[0];

    if (status !== 'pending') {
      return res.status(400).json({ error: "Only pending appointments can be cancelled." });
    }

    if (!is_future) {
      return res.status(400).json({ error: "Cannot cancel past appointments." });
    }

    await pool.query("DELETE FROM appointments WHERE id = $1", [id]);
    res.json({ message: "✅ Appointment cancelled." });
  } catch (err) {
    console.error("❌ Error cancelling appointment:", err.message);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

export default router;
