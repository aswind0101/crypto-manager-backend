import express from "express";
import verifyToken from "../middleware/verifyToken.js";
import pkg from "pg";
const { Pool } = pkg;

const router = express.Router();
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
});

// Chỉ SUPER_ADMIN hoặc Salon_Chu được thêm nhân viên
const SUPER_ADMINS = ["D9nW6SLT2pbUuWbNVnCgf2uINok2"];

router.post("/", verifyToken, async (req, res) => {
    const { uid, email, role: userRole } = req.user;

    if (!SUPER_ADMINS.includes(uid) && userRole !== "Salon_Chu") {
        return res.status(403).json({ error: "Access denied" });
    }

    const { salon_id, name, phone, email: empEmail, role } = req.body;

    if (!name || !role || !salon_id) {
        return res.status(400).json({ error: "Name, role, and salon_id are required" });
    }

    try {
        const result = await pool.query(
            `INSERT INTO employees (salon_id, name, phone, email, role, is_freelancer)
             VALUES ($1, $2, $3, $4, $5, false) RETURNING *`,
            [salon_id, name, phone, empEmail, role]
        );
        res.status(201).json(result.rows[0]);
    } catch (err) {
        console.error("Error adding employee:", err.message);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

export default router;
