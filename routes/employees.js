import express from "express";
import verifyToken from "../middleware/verifyToken.js";
import { attachUserRole } from "../middleware/attachUserRole.js";
import multer from "multer";
import path from "path";
import fs from 'fs';
import { fileURLToPath } from "url";
import pkg from "pg";
const { Pool } = pkg;

const router = express.Router();
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
});
// Polyfill __dirname trong ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SUPER_ADMINS = ["D9nW6SLT2pbUuWbNVnCgf2uINok2"];
// Multer storage: cho vào đúng folder theo URL
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        let dir = "uploads/avatars";
        if (req.originalUrl.includes("certifications")) dir = "uploads/certifications";
        if (req.originalUrl.includes("id_documents")) dir = "uploads/id_documents";
        if (!fs.existsSync(path.join(__dirname, "..", dir))) fs.mkdirSync(path.join(__dirname, "..", dir), { recursive: true });
        cb(null, path.join(__dirname, "..", dir));
    },
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname);
        cb(null, `${req.user.uid}_${Date.now()}${ext}`);
    },
});
const upload = multer({ storage });

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
    const { name, phone, avatar_url, certifications, id_documents, description } = req.body;

    try {
        const result = await pool.query(
            `UPDATE employees SET
                name = COALESCE($1, name),
                phone = COALESCE($2, phone),
                avatar_url = COALESCE($3, avatar_url),
                certifications = COALESCE($4, certifications),
                id_documents = COALESCE($5, id_documents),
                description = COALESCE($6, description),
                updated_at = NOW()
            WHERE firebase_uid = $7
            RETURNING *`,
            [name, phone, avatar_url, certifications, id_documents, description, uid]
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
// API: Upload avatar (xóa avatar cũ trước khi lưu mới)
router.post(
    "/upload/avatar",
    verifyToken,
    upload.single("avatar"),
    async (req, res) => {
        try {
            if (!req.file) {
                return res.status(400).json({ error: "No file uploaded" });
            }

            const { uid } = req.user;

            // 1️⃣ Lấy avatar cũ và xóa file nếu có
            const old = await pool.query(
                "SELECT avatar_url FROM employees WHERE firebase_uid = $1",
                [uid]
            );
            const oldUrl = old.rows[0]?.avatar_url;
            if (oldUrl) {
                const abs = path.join(__dirname, "..", oldUrl);
                if (fs.existsSync(abs)) fs.unlinkSync(abs);
            }

            // 2️⃣ Lưu avatar mới và cập nhật DB
            const filePath = `/uploads/avatars/${req.file.filename}`;
            const result = await pool.query(
                `UPDATE employees
              SET avatar_url = $1
            WHERE firebase_uid = $2
            RETURNING avatar_url`,
                [filePath, uid]
            );
            if (!result.rows.length) {
                return res.status(404).json({ error: "Employee not found" });
            }

            res.json({
                message: "Avatar uploaded",
                avatar_url: result.rows[0].avatar_url,
            });
        } catch (err) {
            console.error("❌ Error uploading avatar:", err.message);
            res.status(500).json({ error: "Internal Server Error" });
        }
    }
);

router.post(
    "/upload/certifications",
    verifyToken,
    upload.array("files"),
    async (req, res) => {
        const { uid } = req.user;
        try {
            // 1️⃣ Lấy và xóa file cũ
            const old = await pool.query(
                "SELECT certifications FROM employees WHERE firebase_uid = $1",
                [uid]
            );
            const oldFiles = old.rows[0]?.certifications || [];
            oldFiles.forEach(rel => {
                const abs = path.join(__dirname, "..", rel);
                if (fs.existsSync(abs)) fs.unlinkSync(abs);
            });

            // 2️⃣ Lưu file mới và cập nhật DB
            const filePaths = req.files.map(f => `/uploads/certifications/${f.filename}`);
            const update = await pool.query(
                `UPDATE employees
              SET certifications = $1,
                  certification_status = 'In Review'
            WHERE firebase_uid = $2
            RETURNING certifications, certification_status, salon_id`,
                [filePaths, uid]
            );
            if (!update.rows.length) {
                return res.status(404).json({ error: "Employee not found" });
            }
            const { certifications, certification_status, salon_id } = update.rows[0];

            // 3️⃣ Emit sự kiện real-time đến room của salon này
            const io = req.app.get("io");
            if (io && salon_id) {
                io.to(`salon_${salon_id}`).emit("certificationsUpdated", {
                    employeeUid: uid,
                    certifications,
                    certification_status,
                });
            }

            // 4️⃣ Trả response về client
            return res.json({
                message: "Certifications uploaded, status set to In Review",
                certifications,
                certification_status,
            });
        } catch (err) {
            console.error("❌ Error uploading certifications:", err.message);
            return res.status(500).json({ error: "Internal Server Error" });
        }
    }
);

router.post(
    "/upload/id_documents",
    verifyToken,
    upload.array("files"),
    async (req, res) => {
        const { uid } = req.user;
        try {
            // 1️⃣ Lấy và xóa file ID Documents cũ
            const old = await pool.query(
                "SELECT id_documents FROM employees WHERE firebase_uid = $1",
                [uid]
            );
            const oldFiles = old.rows[0]?.id_documents || [];
            oldFiles.forEach(rel => {
                const abs = path.join(__dirname, "..", rel);
                if (fs.existsSync(abs)) fs.unlinkSync(abs);
            });

            // 2️⃣ Lưu file mới và cập nhật DB
            const filePaths = req.files.map(f => `/uploads/id_documents/${f.filename}`);
            const update = await pool.query(
                `UPDATE employees
              SET id_documents = $1,
                  id_document_status = 'In Review'
            WHERE firebase_uid = $2
            RETURNING id_documents, id_document_status, salon_id`,
                [filePaths, uid]
            );
            if (!update.rows.length) {
                return res.status(404).json({ error: "Employee not found" });
            }
            const { id_documents, id_document_status, salon_id } = update.rows[0];

            // 3️⃣ Emit real-time cho room salon
            const io = req.app.get("io");
            if (io && salon_id) {
                io.to(`salon_${salon_id}`).emit("idDocumentsUpdated", {
                    employeeUid: uid,
                    id_documents,
                    id_document_status,
                });
            }

            // 4️⃣ Trả response về client
            return res.json({
                message: "ID Documents uploaded, status set to In Review",
                id_documents,
                id_document_status,
            });
        } catch (err) {
            console.error("❌ Error uploading ID documents:", err.message);
            return res.status(500).json({ error: "Internal Server Error" });
        }
    }
);

router.patch(
    "/update-status",
    verifyToken,
    attachUserRole,
    async (req, res) => {
        const { uid, role } = req.user;
        const { employee_id, type, status } = req.body;

        // 1️⃣ quyền chỉ Salon_Chu hoặc SuperAdmin
        if (role !== "Salon_Chu" && !SUPER_ADMINS.includes(uid)) {
            return res.status(403).json({ error: "Access denied" });
        }
        // 2️⃣ validate type & status
        const validTypes = ["certification_status", "id_document_status"];
        const validStatus = ["Approved", "In Review", "Rejected"];
        if (!validTypes.includes(type) || !validStatus.includes(status)) {
            return res.status(400).json({ error: "Invalid type or status" });
        }

        try {
            // 3️⃣ UPDATE và trả về thêm firebase_uid, salon_id
            const { rows } = await pool.query(
                `UPDATE employees
              SET ${type} = $1
            WHERE id = $2
            RETURNING id, firebase_uid, salon_id, certification_status, id_document_status`,
                [status, employee_id]
            );
            if (!rows.length) {
                return res.status(404).json({ error: "Employee not found" });
            }

            const updated = rows[0];

            // 4️⃣ Emit real-time
            const io = req.app.get("io");
            if (io) {
                // a) Notify the employee
                const empRoom = `employee_${updated.firebase_uid}`;
                if (type === "certification_status") {
                    io.to(empRoom).emit("certificationStatusUpdated", {
                        certification_status: updated.certification_status,
                    });
                } else {
                    io.to(empRoom).emit("idDocumentStatusUpdated", {
                        id_document_status: updated.id_document_status,
                    });
                }

                // b) (Optional) Notify the salon owner view so they can refresh list
                const salonRoom = `salon_${updated.salon_id}`;
                io.to(salonRoom).emit("employeeStatusChanged", {
                    employee_id: updated.id,
                    type,
                    status,
                });
            }

            // 5️⃣ Response
            return res.json({
                message: `${type} updated`,
                [type]: status,
            });
        } catch (err) {
            console.error("❌ Error updating status:", err.message);
            return res.status(500).json({ error: "Internal Server Error" });
        }
    }
);
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
