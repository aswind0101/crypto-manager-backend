// 📁 backend/routes/appointments.js
import express from "express";
import verifyToken from "../middleware/verifyToken.js";
import { sendBookingEmail } from "../utils/sendBookingEmail.js";
import { sendAppointmentStatusEmail } from "../utils/sendAppointmentStatusEmail.js";
import { sendStylistCommissionChargedEmail } from '../utils/sendStylistCommissionChargedEmail.js';

import Stripe from "stripe";
import dayjs from "dayjs";
import pkg from "pg";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
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
    return res.status(409).json({
      error: "❌ Stylist already has an appointment in this time range.",
    });
  }

  try {
    const result = await pool.query(
      `INSERT INTO appointments (
         customer_uid, stylist_id, salon_id, service_ids,
         appointment_date, duration_minutes, note
       ) VALUES (
         $1, $2, $3, $4,
         TO_TIMESTAMP($5, 'YYYY-MM-DD HH24:MI:SS'),
         $6, $7
       ) RETURNING *`,
      [uid, stylist_id, salon_id, service_ids, appointment_date, duration_minutes, note || null]
    );

    const appointment = result.rows[0];

    // ✅ Gửi email xác nhận
    try {
      // Lấy email khách hàng
      const userRes = await pool.query(
        `SELECT email FROM users WHERE firebase_uid = $1`,
        [uid]
      );
      const to = userRes.rows[0]?.email;

      // Lấy tên stylist + salon
      const stylistRes = await pool.query(
        `SELECT name FROM freelancers WHERE id = $1`,
        [stylist_id]
      );
      const stylistName = stylistRes.rows[0]?.name || "Stylist";

      const salonRes = await pool.query(
        `SELECT name FROM salons WHERE id = $1`,
        [salon_id]
      );
      const salonName = salonRes.rows[0]?.name || "Salon";

      // Lấy thông tin dịch vụ
      const serviceRes = await pool.query(
        `SELECT name, price, duration_minutes FROM salon_services WHERE id = ANY($1)`,
        [service_ids]
      );

      const formattedDate = dayjs(appointment_date).format("MMMM D, YYYY – hh:mm A");

      if (to) {
        await sendBookingEmail({
          to,
          customerName: to.split("@")[0],
          stylistName,
          salonName,
          dateTime: formattedDate,
          services: serviceRes.rows,
        });
        console.log("✅ Booking email sent to", to);
      }
    } catch (emailErr) {
      console.error("❌ Failed to send booking email:", emailErr.message);
    }

    res.status(201).json(appointment);
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
    a.started_at,  
    a.end_at,
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
    const result = await pool.query(`
  SELECT 
    a.id,
    a.appointment_date,
    a.duration_minutes,
    a.status,
    a.started_at,
    a.end_at,     
    a.note,
    a.customer_uid,
    c.name AS customer_name,
    s.name AS salon_name,
    ARRAY(
      SELECT json_build_object(
        'id', ss.id,
        'name', ss.name,
        'price', ss.price,
        'duration', ss.duration_minutes
      )
      FROM salon_services ss
      WHERE ss.id = ANY(a.service_ids)
    ) AS services
  FROM appointments a
  JOIN freelancers f ON a.stylist_id = f.id
  LEFT JOIN customers c ON a.customer_uid = c.firebase_uid
  LEFT JOIN salons s ON a.salon_id = s.id
  WHERE f.firebase_uid = $1
  ORDER BY a.appointment_date ASC
`, [uid]);


    res.json(result.rows);
  } catch (err) {
    console.error("❌ Error fetching stylist appointments:", err.message);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// ✅ PATCH: Cập nhật trạng thái lịch hẹn
router.patch("/:id", verifyToken, async (req, res) => {
  const { id } = req.params;
  const { status, started_at, end_at } = req.body;

  // Bổ sung "processing" vào danh sách hợp lệ
  if (!["pending", "confirmed", "processing", "completed", "cancelled"].includes(status)) {
    return res.status(400).json({ error: "Invalid status value" });
  }

  try {
    // Nếu status là "confirmed", thực hiện charge 5% hoa hồng ngay
    if (status === "confirmed") {
      // Lấy thông tin appointment
      const apptRes = await pool.query(
        `SELECT * FROM appointments WHERE id = $1`,
        [id]
      );
      if (apptRes.rows.length === 0) {
        return res.status(404).json({ error: "Appointment not found" });
      }
      const appt = apptRes.rows[0];

      // Lấy thông tin freelancer để charge 5%
      const freelancerRes = await pool.query(
        `SELECT stripe_customer_id, stripe_payment_method_id, name, email FROM freelancers WHERE id = $1`,
        [appt.stylist_id]
      );
      const freelancer = freelancerRes.rows[0];
      if (!freelancer || !freelancer.stripe_customer_id || !freelancer.stripe_payment_method_id) {
        return res.status(400).json({ error: "Freelancer chưa thêm payment method hoặc chưa liên kết Stripe!" });
      }

      // Tính tổng tiền dịch vụ của appointment
      const serviceRes = await pool.query(
        `SELECT price FROM salon_services WHERE id = ANY($1)`,
        [appt.service_ids]
      );
      const totalAmount = serviceRes.rows.reduce((sum, s) => sum + (s.price || 0), 0);
      const feeAmount = Math.round(totalAmount * 0.05 * 100); // 5% (USD → cent)

      if (feeAmount > 0) {
        try {
          await stripe.paymentIntents.create({
            amount: feeAmount,
            currency: "usd",
            customer: freelancer.stripe_customer_id,
            payment_method: freelancer.stripe_payment_method_id,
            off_session: true,
            confirm: true,
            description: `5% commission for confirming appointment #${appt.id}`,
            receipt_email: freelancer.email,
          });

          // Sau khi charge thành công, gửi email cho stylist
          // Lấy các dữ liệu cần thiết cho email
          const stylistEmail = freelancer.email;
          const stylistName = freelancer.name;
          const salonRes = await pool.query(
            `SELECT name FROM salons WHERE id = $1`,
            [appt.salon_id]
          );
          const salonName = salonRes.rows[0]?.name || "Salon";
          const servicesRes = await pool.query(
            `SELECT name, price, duration_minutes FROM salon_services WHERE id = ANY($1)`,
            [appt.service_ids]
          );
          const services = servicesRes.rows;
          const totalAmount = services.reduce((sum, s) => sum + parseFloat(s.price), 0);
          const commission = totalAmount * 0.05;
          const formattedDate = dayjs(appt.appointment_date).format("MMMM D, YYYY – hh:mm A");

          if (stylistEmail) {
            await sendStylistCommissionChargedEmail({
              to: stylistEmail,
              stylistName,
              appointmentId: appt.id,
              dateTime: formattedDate,
              salonName,
              services,
              totalAmount,
              commission,
            });
          }

        } catch (err) {
          // Nếu charge lỗi, báo về FE và giữ nguyên trạng thái pending
          return res.status(402).json({
            error: "Could not charge commission fee. Please check your payment method or balance.",
            stripeError: err.message,
          });
        }
      }

    }
    // Tạo câu lệnh SQL động: nếu có started_at thì update cả 2 trường, nếu không chỉ update status
    let updateFields = ['status'];
    let values = [status];
    let idx = 2;

    if (started_at) {
      updateFields.push('started_at');
      values.push(started_at);
      idx++;
    }
    if (end_at) {
      updateFields.push('end_at');
      values.push(end_at);
      idx++;
    }

    let setClause = updateFields.map((f, i) => `${f} = $${i + 1}`).join(', ');
    values.push(id);

    const result = await pool.query(
      `UPDATE appointments SET ${setClause} WHERE id = $${values.length} RETURNING *`,
      values
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Appointment not found" });
    }

    const appt = result.rows[0];

    // ✅ Gửi email nếu là confirmed, cancelled, hoặc processing
    if (["confirmed", "cancelled", "processing"].includes(status)) {
      try {
        const customerRes = await pool.query(
          `SELECT email FROM users WHERE firebase_uid = $1`,
          [appt.customer_uid]
        );
        const to = customerRes.rows[0]?.email;

        const stylistRes = await pool.query(
          `SELECT name FROM freelancers WHERE id = $1`,
          [appt.stylist_id]
        );
        const salonRes = await pool.query(
          `SELECT name FROM salons WHERE id = $1`,
          [appt.salon_id]
        );
        const servicesRes = await pool.query(
          `SELECT name, price, duration_minutes FROM salon_services WHERE id = ANY($1)`,
          [appt.service_ids]
        );

        const formattedDate = dayjs(appt.appointment_date).format("MMMM D, YYYY – hh:mm A");

        if (to) {
          await sendAppointmentStatusEmail({
            to,
            customerName: to.split("@")[0],
            stylistName: stylistRes.rows[0]?.name || "Stylist",
            salonName: salonRes.rows[0]?.name || "Salon",
            dateTime: formattedDate,
            status,
            services: servicesRes.rows,
          });
          console.log(`📧 Email sent to ${to} for status: ${status}`);
        }
      } catch (emailErr) {
        console.error("❌ Failed to send status email:", emailErr.message);
      }
    }

    res.json(appt);
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
      SELECT appointment_date, status
      FROM appointments
      WHERE id = $1 AND customer_uid = $2
    `, [id, uid]);

    if (check.rows.length === 0) {
      return res.status(404).json({ error: "Appointment not found" });
    }

    const { status } = check.rows[0];

    if (status !== "pending") {
      return res.status(400).json({ error: "Only pending appointments can be cancelled." });
    }

    // ✅ KHÔNG kiểm tra thời gian nữa — frontend lo phần này rồi
    await pool.query("DELETE FROM appointments WHERE id = $1", [id]);

    res.json({ message: "✅ Appointment cancelled." });
  } catch (err) {
    console.error("❌ Error cancelling appointment:", err.message);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

export default router;
