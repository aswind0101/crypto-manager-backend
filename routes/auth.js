import express from "express";
import admin from "firebase-admin";
import pkg from "pg";
import verifyToken from "../middleware/verifyToken.js";


const { Pool } = pkg;

const router = express.Router();

// ✅ Kết nối DB (giống các route cũ)
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
});
// auth.js hoặc freelancers.js
router.get("/freelancers/check", async (req, res) => {
    const { email } = req.query;
    if (!email) return res.status(400).json({ exists: false, is_verified: false });

    try {
        const check = await pool.query("SELECT id, is_verified FROM freelancers WHERE email = $1", [email]);
        if (check.rows.length > 0) {
            res.json({ exists: true, is_verified: check.rows[0].is_verified });
        } else {
            res.json({ exists: false, is_verified: false });
        }
    } catch (err) {
        console.error("Error checking freelancer:", err.message);
        res.status(500).json({ exists: false, is_verified: false });
    }
});

// ✅ API: Lấy role user hiện tại
router.get("/user-role", verifyToken, async (req, res) => {
    const { uid, email } = req.user;

    try {
        // 1️⃣ Check trong bảng users
        const userCheck = await pool.query("SELECT role FROM users WHERE firebase_uid = $1", [uid]);

        if (userCheck.rows.length > 0) {
            return res.status(200).json({ role: userCheck.rows[0].role });
        }

        // 2️⃣ Check nếu là chủ salon (email khớp với bảng salons)
        const salonCheck = await pool.query("SELECT id FROM salons WHERE email = $1", [email]);
        if (salonCheck.rows.length > 0) {
            await pool.query(
                "INSERT INTO users (firebase_uid, email, role) VALUES ($1, $2, $3)",
                [uid, email, "Salon_Chu"]
            );
            await pool.query(
                "UPDATE salons SET owner_user_id = $1 WHERE email = $2 AND (owner_user_id IS NULL OR owner_user_id = '')",
                [uid, email]
            );
            return res.status(200).json({ role: "Salon_Chu" });
        }

        // 3️⃣ Check nếu là nhân viên salon
        const employeeCheck = await pool.query("SELECT id FROM employees WHERE email = $1", [email]);
        if (employeeCheck.rows.length > 0) {
            await pool.query(
                "INSERT INTO users (firebase_uid, email, role) VALUES ($1, $2, $3)",
                [uid, email, "Salon_NhanVien"]
            );
            await pool.query(
                "UPDATE employees SET firebase_uid = $1 WHERE email = $2 AND (firebase_uid IS NULL OR firebase_uid = '')",
                [uid, email]
            );
            return res.status(200).json({ role: "Salon_NhanVien" });
        }

        // 4️⃣ ✅ Check nếu là Freelancer
        const freelancerCheck = await pool.query("SELECT id FROM freelancers WHERE email = $1", [email]);
        if (freelancerCheck.rows.length > 0) {
            await pool.query(
                "INSERT INTO users (firebase_uid, email, role) VALUES ($1, $2, $3)",
                [uid, email, "Salon_Freelancers"]
            );
            await pool.query(
                "UPDATE freelancers SET firebase_uid = $1 WHERE email = $2 AND (firebase_uid IS NULL OR firebase_uid = '')",
                [uid, email]
            );
            return res.status(200).json({ role: "Salon_Freelancers" });
        }
        // 5️⃣ Nếu không khớp gì ➝ Crypto (mặc định người dùng hệ thống đầu tư)
        await pool.query(
            "INSERT INTO users (firebase_uid, email, role) VALUES ($1, $2, $3)",
            [uid, email, "Crypto"]
        );
        return res.status(200).json({ role: "Crypto" });

    } catch (err) {
        console.error("❌ Error fetching user role:", err.message);
        res.status(500).json({ error: "Internal Server Error" });
    }
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
