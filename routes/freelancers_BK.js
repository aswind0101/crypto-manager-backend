import express from "express";
import pkg from "pg";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { sendVerifyEmail } from "../utils/sendVerifyEmail.js";
import verifyToken from "../middleware/verifyToken.js";
import multer from "multer";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const { Pool } = pkg;
const router = express.Router();

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 🌐 Multer: phân thư mục theo URL
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        let dir = "uploads/avatars";
        if (req.originalUrl.includes("license")) dir = "uploads/licenses";
        if (req.originalUrl.includes("id")) dir = "uploads/id_documents";
        const fullPath = path.join(__dirname, "..", dir);
        if (!fs.existsSync(fullPath)) fs.mkdirSync(fullPath, { recursive: true });
        cb(null, fullPath);
    },
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname);
        cb(null, `${req.user.uid}_${Date.now()}${ext}`);
    },
});

const upload = multer({ storage });

const updateIsQualifiedStatus = async (firebase_uid) => {
    const result = await pool.query(`
    SELECT avatar_url, license_url, license_status,
           id_doc_url, id_doc_status, payment_connected,
           salon_id, temp_salon_name, temp_salon_address, temp_salon_phone
    FROM freelancers
    WHERE firebase_uid = $1
  `, [firebase_uid]);

    const f = result.rows[0];
    const qualified =
        f.avatar_url &&
        f.license_url && f.license_status === 'Approved' &&
        f.id_doc_url && f.id_doc_status === 'Approved' &&
        f.payment_connected &&
        (
            f.salon_id !== null ||
            (f.temp_salon_name && f.temp_salon_address && f.temp_salon_phone)
        );

    await pool.query("UPDATE freelancers SET isQualified = $1 WHERE firebase_uid = $2", [qualified, firebase_uid]);
};

// ✅ POST /api/freelancers/upload/avatar
router.post("/upload/avatar", verifyToken, upload.single("avatar"), async (req, res) => {
    const { email, uid } = req.user;

    const file = req.file;

    console.log("📩 Email:", email);
    console.log("🔐 UID:", uid);
    console.log("📂 Uploaded File:", file?.originalname || "❌ No file received");
    if (!email || !file) {
        return res.status(400).json({ error: "Missing email or file" });
    }

    const avatarUrl = `/uploads/avatars/${file.filename}`;
    console.log("🖼️ Avatar URL to save:", avatarUrl);

    try {
        // Lấy avatar cũ và xoá (nếu có)
        const old = await pool.query("SELECT avatar_url FROM freelancers WHERE email = $1", [email]);
        const oldPath = old.rows[0]?.avatar_url && path.join(__dirname, "..", old.rows[0].avatar_url);
        if (oldPath && fs.existsSync(oldPath)) fs.unlinkSync(oldPath);

        // Cập nhật avatar mới
        const result = await pool.query(
            "UPDATE freelancers SET avatar_url = $1 WHERE firebase_uid = $2 RETURNING *",
            [avatarUrl, uid]
        );
        console.log("👤 Freelancer updated:", result.rowCount > 0 ? "✅ Success" : "❌ No match found");

        // Nếu có trong bảng employees → cập nhật luôn
        const emp = await pool.query(
            `UPDATE employees SET avatar_url = $1 WHERE firebase_uid = $2 RETURNING *`,
            [avatarUrl, uid]
        );
        console.log("🧑‍💼 Employee updated:", emp.rowCount > 0 ? "✅ Yes" : "❌ Not found");

        res.json({ success: true, avatar_url: avatarUrl });
    } catch (err) {
        console.error("❌ Upload avatar error:", err.message);
        res.status(500).json({ error: "Failed to update freelancer avatar" });
    }
    await updateIsQualifiedStatus(uid);
});
router.post("/upload/id", verifyToken, upload.single("id_doc"), async (req, res) => {
    const { email, uid } = req.user;
    const file = req.file;

    if (!file || !email) {
        return res.status(400).json({ error: "Missing file or email" });
    }

    const idUrl = `/uploads/id_documents/${file.filename}`;

    try {
        // 🧹 Xoá file cũ nếu có
        const old = await pool.query("SELECT id_doc_url FROM freelancers WHERE email = $1", [email]);
        const oldPath = old.rows[0]?.id_doc_url && path.join(__dirname, "..", old.rows[0].id_doc_url);
        if (oldPath && fs.existsSync(oldPath)) fs.unlinkSync(oldPath);

        // 💾 Cập nhật file mới
        await pool.query("UPDATE freelancers SET id_doc_url = $1, id_doc_status = 'In Review' WHERE firebase_uid = $2", [idUrl, uid]);
        // Nếu có trong bảng employees → cập nhật luôn
        await pool.query(`
            UPDATE employees
            SET id_documents = ARRAY[$1], id_document_status = 'In Review'
            WHERE firebase_uid = $2
        `, [idUrl, uid]);

        res.json({ success: true, id_doc_url: idUrl });
    } catch (err) {
        console.error("❌ Upload ID error:", err.message);
        res.status(500).json({ error: "Failed to update freelancer ID" });
    }
    await updateIsQualifiedStatus(uid);
});

// ✅ POST /api/freelancers/upload/license
router.post("/upload/license", verifyToken, upload.single("license"), async (req, res) => {
    const { email, uid } = req.user;
    const file = req.file;

    if (!file || !email) {
        return res.status(400).json({ error: "Missing file or email" });
    }

    const licenseUrl = `/uploads/licenses/${file.filename}`;

    try {
        // 🗑 Lấy license cũ và xoá nếu có
        const old = await pool.query("SELECT license_url FROM freelancers WHERE email = $1", [email]);
        const oldPath = old.rows[0]?.license_url && path.join(__dirname, "..", old.rows[0].license_url);
        if (oldPath && fs.existsSync(oldPath)) fs.unlinkSync(oldPath);

        // 💾 Cập nhật license mới
        await pool.query("UPDATE freelancers SET license_url = $1, license_status = 'In Review' WHERE firebase_uid = $2", [licenseUrl, uid]);
        // Nếu có trong bảng employees → cập nhật luôn
        await pool.query(`
            UPDATE employees
            SET certifications = ARRAY[$1], certification_status = 'In Review'
            WHERE firebase_uid = $2
        `, [licenseUrl, uid]);

        res.json({ success: true, license_url: licenseUrl });
    } catch (err) {
        console.error("❌ Upload license error:", err.message);
        res.status(500).json({ error: "Failed to update freelancer license" });
    }
    await updateIsQualifiedStatus(uid);
});
// GET: /api/freelancers/verify?token=abc123
router.get("/verify", async (req, res) => {
    const { token } = req.query;

    if (!token) {
        return res.status(400).json({ error: "Missing token" });
    }

    try {
        // 1️⃣ Tìm freelancer theo token
        const result = await pool.query(`
            SELECT id, is_verified, email FROM freelancers WHERE verify_token = $1
        `, [token]);

        if (result.rows.length === 0) {
            return res.status(400).json({ error: "Invalid or expired token" });
        }

        const freelancer = result.rows[0];

        if (freelancer.is_verified) {
            return res.status(200).json({ message: "Account already verified." });
        }

        // 2️⃣ Cập nhật trạng thái freelancer
        await pool.query(`
            UPDATE freelancers
            SET is_verified = true,
                verify_token = NULL
            WHERE id = $1
        `, [freelancer.id]);

        // 3️⃣ Kiểm tra user đã có trong bảng users chưa
        const userCheck = await pool.query(`SELECT id, role FROM users WHERE email = $1`, [freelancer.email]);

        if (userCheck.rows.length > 0) {
            // 4️⃣ Kiểm tra nếu user có trong bảng employees
            const empCheck = await pool.query(`SELECT id FROM employees WHERE email = $1`, [freelancer.email]);

            if (empCheck.rows.length > 0) {
                await pool.query(`
                    UPDATE users SET role = 'Salon_All' WHERE id = $1
                `, [userCheck.rows[0].id]);
            }
        } else {
            // 5️⃣ Nếu chưa có user ➜ thêm mới với role là Salon_Freelancers
            await pool.query(`
                INSERT INTO users (email, role)
                VALUES ($1, 'Salon_Freelancers')
            `, [freelancer.email]);
        }

        return res.status(200).json({ message: "✅ Your account has been verified successfully!" });

    } catch (err) {
        console.error("❌ Error verifying token:", err.message);
        return res.status(500).json({ error: "Internal Server Error" });
    }
});

// ✅ Gửi lại email xác minh
router.get("/resend-verify", async (req, res) => {
    const { email } = req.query;
    if (!email) return res.status(400).json({ error: "Missing email" });

    try {
        const result = await pool.query(
            `SELECT id, name, is_verified, verify_token FROM freelancers WHERE email = $1`,
            [email]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: "Email not found" });
        }

        const freelancer = result.rows[0];

        if (freelancer.is_verified) {
            return res.status(400).json({ error: "Account already verified" });
        }

        // Nếu chưa có token thì tạo mới
        let token = freelancer.verify_token;
        if (!token) {
            const crypto = await import('crypto');
            token = crypto.randomBytes(32).toString("hex");

            await pool.query(
                `UPDATE freelancers SET verify_token = $1 WHERE id = $2`,
                [token, freelancer.id]
            );
        }

        // Gửi lại email xác minh
        await sendVerifyEmail({
            to: email,
            name: freelancer.name || "Freelancer",
            token
        });

        res.json({ message: "✅ Verification email resent" });
    } catch (err) {
        console.error("❌ Error resending verify email:", err.message);
        res.status(500).json({ error: "Internal Server Error" });
    }
});
// POST: /api/freelancers/register
router.post("/register", async (req, res) => {
    const {
        name,
        email,
        password,
        phone,
        address,
        gender,
        birthday,
        about,
        experience,
        is_freelancer,           // boolean
        temp_salon_name,         // nếu có
        temp_salon_address,
        temp_salon_phone,
        specialization
    } = req.body;

    // Kiểm tra bắt buộc
    if (!name || !email || !password || !phone || !address || !gender || !birthday || !about || !experience || !specialization) {
        return res.status(400).json({ error: "All fields are required." });
    }

    try {
        // Kiểm tra email trùng
        const check = await pool.query(`SELECT id FROM freelancers WHERE email = $1`, [email]);
        if (check.rows.length > 0) {
            return res.status(400).json({ error: "Email already registered" });
        }

        // Hash password
        const hashedPassword = await bcrypt.hash(password, 10);
        const verifyToken = crypto.randomBytes(32).toString("hex");

        // Insert
        const result = await pool.query(`
            INSERT INTO freelancers 
                (name, email, password, phone, address, gender, birthday, about, experience, is_freelancer,
                 temp_salon_name, temp_salon_address, temp_salon_phone, verify_token, specialization)
            VALUES 
                ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
         $11, $12, $13, $14, $15)
            RETURNING id
        `, [
            name,
            email,
            hashedPassword,
            phone || null,
            address || null,
            gender || null,
            birthday || null,
            about || null,
            experience || null,
            is_freelancer !== false, // nếu không gửi thì mặc định true
            temp_salon_name || null,
            temp_salon_address || null,
            temp_salon_phone || null,
            verifyToken,
            specialization || null
        ]);
        await sendVerifyEmail({
            to: email,
            name,
            token: verifyToken
        });
        // TODO: gửi email xác minh
        return res.status(201).json({
            message: "Freelancer registered. Please check your email to verify.",
            verify_token: verifyToken // chỉ để test/dev
        });

    } catch (err) {
        console.error("❌ Error registering freelancer:", err.message);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

// 📌 GET /api/freelancers/onboarding
router.get("/onboarding", verifyToken, async (req, res) => {
    const { uid } = req.user;

    try {
        const result = await pool.query(
            `SELECT
     avatar_url IS NOT NULL AS has_avatar,
     license_url IS NOT NULL AS has_license,
     id_doc_url IS NOT NULL AS has_id,
     salon_id IS NOT NULL AS has_salon,
     payment_connected AS has_payment, -- ✅ Đã thay đổi ở đây
     isQualified,
     license_status,
     id_doc_status,
     avatar_url,
     license_url,
     id_doc_url
   FROM freelancers
   WHERE firebase_uid = $1`,
            [uid]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: "Freelancer not found" });
        }

        res.json(result.rows[0]);
    } catch (err) {
        console.error("❌ Error fetching onboarding status:", err.message);
        res.status(500).json({ error: "Internal Server Error" });
    }
});
const SUPER_ADMINS = ["D9nW6SLT2pbUuWbNVnCgf2uINok2"];

router.get("/pending-docs", verifyToken, async (req, res) => {
    const { uid } = req.user;

    if (!SUPER_ADMINS.includes(uid)) {
        return res.status(403).json({ error: "Access denied" });
    }

    try {
        const result = await pool.query(`
      SELECT id, name, email, avatar_url, license_url, id_doc_url,
             license_status, id_doc_status
      FROM freelancers
      WHERE license_status = 'In Review' OR id_doc_status = 'In Review'
    `);

        res.json(result.rows);
    } catch (err) {
        console.error("❌ Error loading pending docs:", err.message);
        res.status(500).json({ error: "Internal Server Error" });
    }
});
router.patch("/verify-doc", verifyToken, async (req, res) => {
    const { uid } = req.user;

    if (!SUPER_ADMINS.includes(uid)) {
        return res.status(403).json({ error: "Access denied" });
    }

    const { email, field, status } = req.body;

    if (!email || !["license", "id_doc"].includes(field) || !["Approved", "Rejected"].includes(status)) {
        return res.status(400).json({ error: "Invalid input" });
    }

    const fieldName = field === "license" ? "license_status" : "id_doc_status";

    try {
        await pool.query(
            `UPDATE freelancers SET ${fieldName} = $1 WHERE email = $2`,
            [status, email]
        );

        // 🔁 Lấy firebase_uid của freelancer để gọi updateIsQualifiedStatus
        const result = await pool.query("SELECT firebase_uid FROM freelancers WHERE email = $1", [email]);
        const freelancerUid = result.rows[0]?.firebase_uid;

        if (freelancerUid) {
            await updateIsQualifiedStatus(freelancerUid);
        }

        res.json({ message: `✅ ${field} status updated to ${status}` });
    } catch (err) {
        console.error("❌ Error updating doc status:", err.message);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

// PATCH: Freelancer chọn salon
router.patch("/select-salon", verifyToken, async (req, res) => {
    const { uid } = req.user;
    const { salon_id } = req.body;

    if (!salon_id) {
        return res.status(400).json({ error: "Missing salon_id" });
    }

    try {
        // 1️⃣ Kiểm tra salon có tồn tại và đang hoạt động
        const checkSalon = await pool.query(
            `SELECT id, name, address, phone FROM salons WHERE id = $1 AND status = 'active'`,
            [salon_id]
        );
        if (checkSalon.rows.length === 0) {
            return res.status(404).json({ error: "Salon not found or inactive" });
        }
        const salon = checkSalon.rows[0];

        // 2️⃣ Cập nhật salon_id và thông tin tạm thời trong bảng freelancers
        await pool.query(
            `UPDATE freelancers
             SET salon_id = $1,
                 temp_salon_name = $2,
                 temp_salon_address = $3,
                 temp_salon_phone = $4
             WHERE firebase_uid = $5`,
            [salon_id, salon.name, salon.address, salon.phone, uid]
        );

        // 3️⃣ Lấy thông tin freelancer để sync vào bảng employees
        const result = await pool.query(
            `SELECT name, email, phone, avatar_url, license_url, id_doc_url, specialization
             FROM freelancers
             WHERE firebase_uid = $1`,
            [uid]
        );
        const freelancer = result.rows[0];

        // 4️⃣ Kiểm tra xem đã có trong bảng employees hay chưa
        const checkEmp = await pool.query(
            `SELECT id FROM employees WHERE firebase_uid = $1 AND salon_id = $2`,
            [uid, salon_id]
        );

        if (checkEmp.rows.length > 0) {
            // Nếu đã từng bị từ chối ➝ chuyển lại thành inactive
            await pool.query(
                `UPDATE employees
     SET status = 'inactive',
         freelancers_system = true
     WHERE id = $1`,
                [checkEmp.rows[0].id]
            );
        } else {
            // Chưa có ➝ insert mới
            await pool.query(
                `INSERT INTO employees (
      salon_id, firebase_uid, name, phone, email,
      role, status, is_freelancer,
      avatar_url, certifications, id_documents,
      certification_status, id_document_status,
      freelancers_system
    )
    VALUES (
      $1, $2, $3, $4, $5,
      $6, 'inactive', true,
      $7, ARRAY[$8], ARRAY[$9],
      'In Review', 'In Review',
      true
    )`,
                [
                    salon_id,
                    uid,
                    freelancer.name,
                    freelancer.phone,
                    freelancer.email,
                    freelancer.specialization || 'freelancer',
                    freelancer.avatar_url,
                    freelancer.license_url,
                    freelancer.id_doc_url,
                ]
            );
            // 5️⃣ Cập nhật role = 'Salon_All' trong bảng users nếu user đã tồn tại
            const userCheck = await pool.query(`SELECT id FROM users WHERE firebase_uid = $1`, [uid]);
            if (userCheck.rows.length > 0) {
                await pool.query(`UPDATE users SET role = 'Salon_All' WHERE id = $1`, [userCheck.rows[0].id]);
            }
        }

        res.json({ message: "Salon selected and synced to employees" });
    } catch (err) {
        console.error("❌ Error selecting salon:", err.message);
        res.status(500).json({ error: "Internal Server Error" });
    }
    await updateIsQualifiedStatus(uid);
});
router.get("/check", verifyToken, async (req, res) => {
    const { uid } = req.user;
    try {
        const check = await pool.query("SELECT id FROM freelancers WHERE firebase_uid = $1", [uid]);
        return res.json({ exists: check.rows.length > 0 });
    } catch (err) {
        console.error("❌ Error checking freelancer by uid:", err.message);
        return res.status(500).json({ error: "Internal Server Error" });
    }
});

// PATCH: Đánh dấu freelancer đã thêm phương thức thanh toán (giả lập)
router.patch("/mark-payment-added", verifyToken, async (req, res) => {
    const { uid } = req.user;
    try {
        await pool.query(`
      UPDATE freelancers
      SET payment_connected = true
      WHERE firebase_uid = $1
    `, [uid]);

        res.json({ message: "✅ Payment method marked as added." });
    } catch (err) {
        console.error("❌ Error updating payment status:", err.message);
        res.status(500).json({ error: "Failed to update payment status" });
    }
    await updateIsQualifiedStatus(uid);
});

export default router;