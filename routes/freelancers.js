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

// Polyfill __dirname trong ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Multer cấu hình cho avatar
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const dir = path.join(__dirname, "..", "uploads", "avatars");
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
    },
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname);
        const uid = req.user.uid || "user"; // fallback nếu uid không có
        const timestamp = Date.now();
        cb(null, `${uid}_${timestamp}${ext}`);
    },
});
const upload = multer({ storage });

// ✅ POST /api/freelancers/upload/avatar
router.post("/upload/avatar", verifyToken, upload.single("avatar"), async (req, res) => {
    const { email } = req.user;
    const file = req.file;

    if (!email || !file) {
        return res.status(400).json({ error: "Missing email or file" });
    }

    const avatarUrl = `/uploads/avatars/${file.filename}`;

    try {
        // Lấy avatar cũ và xoá (nếu có)
        const old = await pool.query("SELECT avatar_url FROM freelancers WHERE email = $1", [email]);
        const oldPath = old.rows[0]?.avatar_url && path.join(__dirname, "..", old.rows[0].avatar_url);
        if (oldPath && fs.existsSync(oldPath)) fs.unlinkSync(oldPath);

        // Cập nhật avatar mới
        await pool.query("UPDATE freelancers SET avatar_url = $1 WHERE email = $2", [avatarUrl, email]);

        res.json({ success: true, avatar_url: avatarUrl });
    } catch (err) {
        console.error("❌ Upload avatar error:", err.message);
        res.status(500).json({ error: "Failed to update freelancer avatar" });
    }
});
// GET: /api/freelancers/verify?token=abc123
router.get("/verify", async (req, res) => {
    const { token } = req.query;

    if (!token) {
        return res.status(400).json({ error: "Missing token" });
    }

    try {
        const result = await pool.query(`
      SELECT id, is_verified FROM freelancers WHERE verify_token = $1
    `, [token]);

        if (result.rows.length === 0) {
            return res.status(400).json({ error: "Invalid or expired token" });
        }

        const freelancer = result.rows[0];

        if (freelancer.is_verified) {
            return res.status(200).json({ message: "Account already verified." });
        }

        await pool.query(`
      UPDATE freelancers
      SET is_verified = true, verify_token = NULL
      WHERE id = $1
    `, [freelancer.id]);

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
        temp_salon_phone
    } = req.body;

    // Kiểm tra bắt buộc
    if (!name || !email || !password) {
        return res.status(400).json({ error: "Name, email, and password are required" });
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
                 temp_salon_name, temp_salon_address, temp_salon_phone, verify_token)
            VALUES 
                ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
                 $11, $12, $13, $14)
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
            verifyToken
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

export default router;