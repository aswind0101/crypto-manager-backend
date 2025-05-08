import express from "express";
import verifyToken from "../middleware/verifyToken.js";
import { attachUserRole } from "../middleware/attachUserRole.js";
import multer from "multer";
import path from "path";
import pkg from "pg";
const { Pool } = pkg;

const router = express.Router();
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
});

const SUPER_ADMINS = ["D9nW6SLT2pbUuWbNVnCgf2uINok2"];
// Setup multer storage
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, "uploads/avatars/");
    },
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname);
        cb(null, req.user.uid + "_" + Date.now() + ext);
    },
});
const upload = multer({ storage: storage });

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
// GET: Nhân viên lấy profile của chính mình
router.get("/me", verifyToken, async (req, res) => {
    const { uid } = req.user;

    try {
        const emp = await pool.query(
            `SELECT * FROM employees WHERE firebase_uid = $1`,
            [uid]
        );

        if (emp.rows.length === 0) {
            return res.status(404).json({ error: "Employee not found" });
        }

        res.json(emp.rows[0]);
    } catch (err) {
        console.error("❌ Error fetching employee me:", err.message);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

// PATCH: Nhân viên update profile của chính mình
router.patch("/me", verifyToken, async (req, res) => {
    const { uid } = req.user;
    const { name, phone, avatar_url, certifications, id_documents } = req.body;

    try {
        const result = await pool.query(
            `UPDATE employees SET
                name = COALESCE($1, name),
                phone = COALESCE($2, phone),
                avatar_url = COALESCE($3, avatar_url),
                certifications = COALESCE($4, certifications),
                id_documents = COALESCE($5, id_documents),
                updated_at = NOW()
            WHERE firebase_uid = $6
            RETURNING *`,
            [name, phone, avatar_url, certifications, id_documents, uid]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: "Employee not found" });
        }

        res.json(result.rows[0]);
    } catch (err) {
        console.error("❌ Error updating employee me:", err.message);
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
// API: Upload avatar
router.post("/upload/avatar", verifyToken, upload.single("avatar"), async (req, res) => {
    const { uid } = req.user;
    const filePath = `/uploads/avatars/${req.file.filename}`;

    try {
        const result = await pool.query(
            `UPDATE employees SET avatar_url = $1 WHERE firebase_uid = $2 RETURNING *`,
            [filePath, uid]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: "Employee not found" });
        }

        res.json({ message: "Avatar uploaded", avatar_url: filePath });
    } catch (err) {
        console.error("❌ Error uploading avatar:", err.message);
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
