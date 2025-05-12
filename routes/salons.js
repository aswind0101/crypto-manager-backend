// routes/salons.js
import express from "express";
import verifyToken from "../middleware/verifyToken.js";
import pkg from "pg";
const { Pool } = pkg;

const router = express.Router();

// ✅ Kết nối DB
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
});

// 🔑 Super Admin UID list
const SUPER_ADMINS = ["D9nW6SLT2pbUuWbNVnCgf2uINok2"];  // 👈 Thay UID này bằng UID thật của bạn

// GET: Lấy danh sách salon
router.get("/", verifyToken, async (req, res) => {
    if (!SUPER_ADMINS.includes(req.user.uid)) {
        return res.status(403).json({ error: "Access denied" });
    }
    try {
        const result = await pool.query("SELECT * FROM salons ORDER BY id DESC");
        res.json(result.rows);
    } catch (err) {
        console.error("❌ Error fetching salons:", err.message);
        res.status(500).json({ error: "Internal Server Error" });
    }
});
router.get("/me", verifyToken, async (req, res) => {
    const { uid } = req.user;
    try {
        const result = await pool.query(`
            SELECT id, name, address, phone, email 
            FROM salons 
            WHERE owner_user_id = $1
        `, [uid]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: "Salon not found for this user" });
        }

        res.json(result.rows[0]);
    } catch (err) {
        console.error("❌ Error fetching salon for owner:", err.message);
        res.status(500).json({ error: "Internal Server Error" });
    }
});
// ✅ GET: /api/salons/by-id
router.get("/by-id", verifyToken, async (req, res) => {
    const { uid } = req.user;

    try {
        // 🔍 Lấy salon_id từ bảng freelancers
        const resultFreelancer = await pool.query(
            `SELECT salon_id FROM freelancers WHERE firebase_uid = $1`,
            [uid]
        );

        if (resultFreelancer.rows.length === 0 || !resultFreelancer.rows[0].salon_id) {
            return res.status(404).json({ error: "Salon not assigned for this user" });
        }

        const salonId = resultFreelancer.rows[0].salon_id;

        // 🔍 Lấy thông tin salon từ ID
        const resultSalon = await pool.query(
            `SELECT id, name, address, phone, email FROM salons WHERE id = $1`,
            [salonId]
        );

        if (resultSalon.rows.length === 0) {
            return res.status(404).json({ error: "Salon not found" });
        }

        res.json(resultSalon.rows[0]);
    } catch (err) {
        console.error("❌ Error fetching salon by ID:", err.message);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

// GET: Lấy danh sách salon đang hoạt động
router.get("/active", async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT id, name, address, phone FROM salons WHERE status = 'active' ORDER BY name ASC`
        );
        res.json(result.rows);
    } catch (err) {
        console.error("❌ Error fetching active salons:", err.message);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

// POST: Thêm salon mới
router.post("/", verifyToken, async (req, res) => {
    if (!SUPER_ADMINS.includes(req.user.uid)) {
        return res.status(403).json({ error: "Access denied" });
    }

    const { name, address, phone, email, owner_user_id, status } = req.body;

    // Check bắt buộc Name
    if (!name) {
        return res.status(400).json({ error: "Name is required" });
    }

    // Check bắt buộc Email
    if (!email) {
        return res.status(400).json({ error: "Email is required" });
    }

    // Check định dạng email (simple regex)
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
        return res.status(400).json({ error: "Invalid email format" });
    }

    try {
        // Kiểm tra xem email đã tồn tại chưa
        const emailCheck = await pool.query("SELECT id FROM salons WHERE email = $1", [email]);
        if (emailCheck.rows.length > 0) {
            return res.status(400).json({ error: "This email already exists in the system" });
        }

        // Thêm salon mới
        const result = await pool.query(
            `INSERT INTO salons (name, address, phone, email, owner_user_id, status)
                VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
            [name, address || "", phone || "", email, owner_user_id || null, status || "active"]
        );

        res.status(201).json(result.rows[0]);
    } catch (err) {
        console.error("❌ Error adding salon:", err.message);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

// PATCH: Cập nhật salon
router.patch("/:id", verifyToken, async (req, res) => {
    if (!SUPER_ADMINS.includes(req.user.uid)) {
        return res.status(403).json({ error: "Access denied" });
    }
    const { id } = req.params;
    const { name, address, phone, email, owner_user_id, status } = req.body;
    try {
        const result = await pool.query(
            `UPDATE salons SET
                name = COALESCE($1, name),
                address = COALESCE($2, address),
                phone = COALESCE($3, phone),
                email = COALESCE($4, email),
                owner_user_id = COALESCE($5, owner_user_id),
                status = COALESCE($6, status),
                updated_at = NOW()
            WHERE id = $7 RETURNING *`
            ,
            [name, address, phone, email, owner_user_id, status, id]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ error: "Salon not found" });
        }
        res.json(result.rows[0]);
    } catch (err) {
        console.error("❌ Error updating salon:", err.message);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

// DELETE: Xoá salon (hoặc soft delete)
router.delete("/:id", verifyToken, async (req, res) => {
    if (!SUPER_ADMINS.includes(req.user.uid)) {
        return res.status(403).json({ error: "Access denied" });
    }
    const { id } = req.params;
    try {
        // 👉 Soft delete: đổi trạng thái thành inactive
        const result = await pool.query(
            `UPDATE salons SET status = 'inactive', updated_at = NOW() WHERE id = $1 RETURNING *`,
            [id]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ error: "Salon not found" });
        }
        res.json({ message: "Salon marked as inactive" });
    } catch (err) {
        console.error("❌ Error deleting salon:", err.message);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

export default router;
