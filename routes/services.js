// 📁 routes/services.js
import express from "express";
import verifyToken from "../middleware/verifyToken.js";
import pkg from "pg";
const { Pool } = pkg;

const router = express.Router();

// ✅ Kết nối database
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
});
// ✅ GET: Lấy danh sách dịch vụ của salon hiện tại (nếu ?me=1)
router.get("/", verifyToken, async (req, res) => {
    const { uid } = req.user;

    // Lấy theo salon hiện tại
    if (req.query.me === "1") {
        try {
            const salonRes = await pool.query(
                `SELECT id FROM salons WHERE owner_user_id = $1`,
                [uid]
            );

            if (salonRes.rows.length === 0) {
                return res.status(404).json({ error: "Salon not found for current user." });
            }

            const salon_id = salonRes.rows[0].id;

            const result = await pool.query(
                `SELECT * FROM salon_services WHERE salon_id = $1 AND is_active = true ORDER BY created_at DESC`,
                [salon_id]
            );

            res.json(result.rows);
        } catch (err) {
            console.error("❌ Error fetching services:", err.message);
            res.status(500).json({ error: "Internal Server Error" });
        }
    } else {
        res.status(400).json({ error: "Missing or invalid query: me=1" });
    }
});
// ✅ POST: Tạo dịch vụ mới cho salon
router.post("/", verifyToken, async (req, res) => {
    const { uid } = req.user;
    const {
        specialization,
        name,
        description,
        price,
        duration_minutes,
        promotion
    } = req.body;

    if (!specialization || !name || !price || !duration_minutes) {
        return res.status(400).json({ error: "Missing required fields." });
    }

    try {
        // 🔍 Tìm salon_id từ uid chủ salon
        const salonRes = await pool.query(
            `SELECT id FROM salons WHERE owner_user_id = $1`,
            [uid]
        );

        if (salonRes.rows.length === 0) {
            return res.status(404).json({ error: "Salon not found for this user." });
        }

        const salon_id = salonRes.rows[0].id;

        // ✅ Kiểm tra trùng tên dịch vụ (không phân biệt hoa thường)
        const checkDuplicate = await pool.query(
            `SELECT id FROM salon_services
       WHERE salon_id = $1 AND LOWER(name) = LOWER($2)
       AND specialization = $3 AND is_active = true`,
            [salon_id, name.trim(), specialization]
        );

        if (checkDuplicate.rows.length > 0) {
            return res.status(409).json({
                error: "A service with this name already exists for this specialization."
            });
        }

        // ➕ Thêm dịch vụ mới
        const insert = await pool.query(
            `INSERT INTO salon_services
      (salon_id, specialization, name, description, price, duration_minutes, promotion)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *`,
            [salon_id, specialization, name.trim(), description, price, duration_minutes, promotion]
        );

        res.status(201).json(insert.rows[0]);
    } catch (err) {
        console.error("❌ Error creating service:", err.message);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

// ✅ PATCH: Cập nhật dịch vụ theo ID
router.patch("/:id", verifyToken, async (req, res) => {
    const { id } = req.params;
    const { uid } = req.user;
    const {
        name,
        description,
        price,
        duration_minutes,
        promotion,
        specialization,
    } = req.body;

    try {
        // Kiểm tra salon sở hữu dịch vụ này
        const salonCheck = await pool.query(
            `SELECT s.id FROM salons s
       JOIN salon_services ss ON s.id = ss.salon_id
       WHERE ss.id = $1 AND s.owner_user_id = $2`,
            [id, uid]
        );

        if (salonCheck.rows.length === 0) {
            return res.status(403).json({ error: "Not authorized to edit this service." });
        }

        const result = await pool.query(
            `UPDATE salon_services SET
         name = COALESCE($1, name),
         description = COALESCE($2, description),
         price = COALESCE($3, price),
         duration_minutes = COALESCE($4, duration_minutes),
         promotion = COALESCE($5, promotion),
         specialization = COALESCE($6, specialization)
       WHERE id = $7
       RETURNING *`,
            [name, description, price, duration_minutes, promotion, specialization, id]
        );

        res.json(result.rows[0]);
    } catch (err) {
        console.error("❌ Error updating service:", err.message);
        res.status(500).json({ error: "Internal Server Error" });
    }
});
// ❌ DELETE: Xoá mềm service
router.delete("/:id", verifyToken, async (req, res) => {
    const { uid } = req.user;
    const { id } = req.params;

    try {
        const check = await pool.query(
            `SELECT ss.id FROM salon_services ss
       JOIN salons s ON ss.salon_id = s.id
       WHERE ss.id = $1 AND s.owner_user_id = $2`,
            [id, uid]
        );

        if (check.rows.length === 0) {
            return res.status(403).json({ error: "You are not allowed to delete this service." });
        }

        await pool.query(
            `UPDATE salon_services SET is_active = false WHERE id = $1`,
            [id]
        );

        res.json({ message: "Service deleted (soft) successfully." });
    } catch (err) {
        console.error("❌ Error deleting service:", err.message);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

export default router;
