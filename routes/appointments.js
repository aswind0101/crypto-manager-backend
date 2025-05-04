// ==== backend/routes/appointments.js ====
import express from "express";
const router = express.Router();

import verifyToken from "../middleware/verifyToken.js";
import checkRole from "../middleware/checkRole.js";
import pkg from "pg";
const { Pool } = pkg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ✅ 1️⃣ Khách hàng tạo lịch hẹn
router.post("/", verifyToken, checkRole(['customer']), async (req, res) => {
  const { salon_id, staff_id, service_id, appointment_time, notes } = req.body;
  const customer_id = req.user.db_id;  // id trong bảng users

  try {
    const result = await pool.query(
      `INSERT INTO appointments (salon_id, customer_id, staff_id, service_id, appointment_time, notes)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [salon_id, customer_id, staff_id, service_id, appointment_time, notes]
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error("Error creating appointment:", error.message);
    res.status(500).json({ error: "Failed to create appointment" });
  }
});

// ✅ 2️⃣ Nhân viên & chủ salon xem lịch hẹn (lọc theo salon_id)
router.get("/", verifyToken, checkRole(['staff', 'owner']), async (req, res) => {
  const { salon_id } = req.query;

  try {
    const result = await pool.query(
      `SELECT a.*, 
              u.full_name AS customer_name, 
              s.full_name AS staff_name,
              sv.name AS service_name
       FROM appointments a
       LEFT JOIN users u ON a.customer_id = u.id
       LEFT JOIN staff st ON a.staff_id = st.id
       LEFT JOIN users s ON st.user_id = s.id
       LEFT JOIN services sv ON a.service_id = sv.id
       WHERE a.salon_id = $1
       ORDER BY a.appointment_time ASC`,
      [salon_id]
    );

    res.json(result.rows);
  } catch (error) {
    console.error("Error fetching appointments:", error.message);
    res.status(500).json({ error: "Failed to fetch appointments" });
  }
});

// ✅ 3️⃣ Update trạng thái cuộc hẹn (check-in/check-out)
router.patch("/:id/status", verifyToken, checkRole(['staff', 'owner']), async (req, res) => {
  const { status } = req.body;
  const { id } = req.params;

  try {
    const result = await pool.query(
      `UPDATE appointments SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
      [status, id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Appointment not found" });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error("Error updating status:", error.message);
    res.status(500).json({ error: "Failed to update appointment status" });
  }
});

export default router;
