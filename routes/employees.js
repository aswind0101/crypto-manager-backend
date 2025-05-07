import express from "express";
import verifyToken from "../middleware/verifyToken.js";
import { attachUserRole } from "../middleware/attachUserRole.js";
import pkg from "pg";
const { Pool } = pkg;

const router = express.Router();
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
});

const SUPER_ADMINS = ["D9nW6SLT2pbUuWbNVnCgf2uINok2"];

router.get("/", verifyToken, attachUserRole, async (req, res) => {
    const { uid, email, role: userRole } = req.user;
    const normalizedRole = userRole ? userRole.trim().toLowerCase() : "";

    try {
        let result;

        if (SUPER_ADMINS.includes(uid)) {
            result = await pool.query(`SELECT * FROM employees ORDER BY id DESC`);
        } else if (normalizedRole === "salon_chu") {
            let salon = await pool.query(`SELECT id FROM salons WHERE owner_user_id = $1`, [uid]);

            if (salon.rows.length === 0) {
                salon = await pool.query(`SELECT id FROM salons WHERE email = $1`, [email]);
            }

            if (salon.rows.length === 0) {
                return res.status(404).json({ error: "Salon not found for this user" });
            }

            const salonId = salon.rows[0].id;

            result = await pool.query(
                `SELECT * FROM employees WHERE salon_id = $1 ORDER BY id DESC`,
                [salonId]
            );
        } else {
            console.log("❗ Access denied → uid:", uid, "email:", email, "userRole:", userRole);
            return res.status(403).json({ error: "Access denied" });
        }

        res.json(result.rows);
    } catch (err) {
        console.error("❌ Error fetching employees:", err.message);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

router.post("/", verifyToken, attachUserRole, async (req, res) => {
    const { uid, role: userRole } = req.user;
    const normalizedRole = userRole ? userRole.trim().toLowerCase() : "";

    if (!SUPER_ADMINS.includes(uid) && normalizedRole !== "salon_chu") {
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

router.delete("/:id", verifyToken, attachUserRole, async (req, res) => {
    const { uid, role: userRole } = req.user;
    const { id } = req.params;
    const normalizedRole = userRole ? userRole.trim().toLowerCase() : "";

    if (!SUPER_ADMINS.includes(uid) && normalizedRole !== "salon_chu") {
        return res.status(403).json({ error: "Access denied" });
    }

    try {
        const result = await pool.query(
            `DELETE FROM employees WHERE id = $1 RETURNING *`,
            [id]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ error: "Employee not found" });
        }
        res.json({ message: "Employee deleted" });
    } catch (err) {
        console.error("❌ Error deleting employee:", err.message);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

export default router;
