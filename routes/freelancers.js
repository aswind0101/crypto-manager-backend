import express from "express";
import pkg from "pg";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { sendVerifyEmail } from "../utils/sendVerifyEmail.js";


const { Pool } = pkg;
const router = express.Router();

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
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