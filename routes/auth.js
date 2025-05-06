const express = require("express");
const router = express.Router();
const admin = require("firebase-admin");
const { Pool } = require("pg");

// ✅ Kết nối DB (giống các route cũ)
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
});

// POST: Đăng ký tài khoản mới
router.post("/register", async (req, res) => {
    const { email, password, role } = req.body;

    // Kiểm tra rỗng
    if (!email || !password) {
        return res.status(400).json({ error: "Email and password are required." });
    }

    // Kiểm tra định dạng email
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
        return res.status(400).json({ error: "Invalid email format." });
    }

    // Chỉ cho phép role KhachHang hoặc Freelancer
    const allowedRoles = ["KhachHang", "Freelancer"];
    const finalRole = allowedRoles.includes(role) ? role : "KhachHang";

    try {
        // 1️⃣ Tạo tài khoản trên Firebase Auth
        const userRecord = await admin.auth().createUser({
            email,
            password,
        });
        const firebase_uid = userRecord.uid;

        // 2️⃣ Kiểm tra email đã tồn tại trong bảng users chưa
        const check = await pool.query("SELECT id FROM users WHERE email = $1", [email]);
        if (check.rows.length > 0) {
            return res.status(400).json({ error: "Email already registered in the system." });
        }

        // 3️⃣ Lưu vào bảng users
        await pool.query(
            "INSERT INTO users (firebase_uid, email, role) VALUES ($1, $2, $3)",
            [firebase_uid, email, finalRole]
        );

        res.status(201).json({
            message: "User registered successfully",
            uid: firebase_uid,
            role: finalRole,
        });
    } catch (err) {
        console.error("❌ Error registering user:", err.message);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

export default router;
