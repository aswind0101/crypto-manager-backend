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
        // 1️⃣ Nếu đã có user theo firebase_uid ➜ trả về role
        const userByUID = await pool.query("SELECT role FROM users WHERE firebase_uid = $1", [uid]);
        if (userByUID.rows.length > 0) {
            const role = userByUID.rows[0].role;

            // ✅ Nếu role là nhân viên, nhưng user đã đăng ký freelancer ➜ cập nhật firebase_uid nếu chưa có
            const freelancerCheck = await pool.query(`
                SELECT id FROM freelancers 
                WHERE email = $1 AND (firebase_uid IS NULL OR firebase_uid = '')
            `, [email]);

            if (freelancerCheck.rows.length > 0) {
                await pool.query(
                    "UPDATE freelancers SET firebase_uid = $1 WHERE email = $2",
                    [uid, email]
                );
            }

            return res.status(200).json({ role });
        }


        // 2️⃣ Nếu chưa có firebase_uid ➜ kiểm tra theo email
        const userByEmail = await pool.query("SELECT id, role, firebase_uid FROM users WHERE email = $1", [email]);
        if (userByEmail.rows.length > 0) {
            // Nếu chưa có firebase_uid thì update
            if (!userByEmail.rows[0].firebase_uid) {
                await pool.query("UPDATE users SET firebase_uid = $1 WHERE email = $2", [uid, email]);
            }
            // ✅ Dù sao cũng nên cập nhật luôn freelancers nếu có
            // ✅ Cập nhật firebase_uid vào bảng freelancers nếu có email và chưa có UID
            const freelancerCheck = await pool.query(`
            SELECT id FROM freelancers 
            WHERE email = $1 AND (firebase_uid IS NULL OR firebase_uid = '')
            `, [email]);

            if (freelancerCheck.rows.length > 0) {
                await pool.query(
                    "UPDATE freelancers SET firebase_uid = $1 WHERE email = $2",
                    [uid, email]
                );
            }

            return res.status(200).json({ role: userByEmail.rows[0].role });
        }

        // 3️⃣ Nếu là chủ salon
        const salonCheck = await pool.query("SELECT id FROM salons WHERE email = $1", [email]);
        if (salonCheck.rows.length > 0) {
            await pool.query("INSERT INTO users (firebase_uid, email, role) VALUES ($1, $2, 'Salon_Chu')", [uid, email]);
            await pool.query(
                "UPDATE salons SET owner_user_id = $1 WHERE email = $2 AND (owner_user_id IS NULL OR owner_user_id = '')",
                [uid, email]
            );
            return res.status(200).json({ role: "Salon_Chu" });
        }

        // 4️⃣ Nếu là nhân viên salon
        const empCheck = await pool.query("SELECT id FROM employees WHERE email = $1", [email]);
        if (empCheck.rows.length > 0) {
            await pool.query("INSERT INTO users (firebase_uid, email, role) VALUES ($1, $2, 'Salon_NhanVien')", [uid, email]);
            await pool.query(
                "UPDATE employees SET firebase_uid = $1 WHERE email = $2 AND (firebase_uid IS NULL OR firebase_uid = '')",
                [uid, email]
            );
            return res.status(200).json({ role: "Salon_NhanVien" });
        }

        // 5️⃣ Nếu là freelancer
        const freelancerCheck = await pool.query("SELECT id FROM freelancers WHERE email = $1", [email]);
        if (freelancerCheck.rows.length > 0) {
            // Nếu chưa có firebase_uid thì update luôn
            await pool.query(
                "UPDATE freelancers SET firebase_uid = $1 WHERE email = $2 AND (firebase_uid IS NULL OR firebase_uid = '')",
                [uid, email]
            );
            // Kiểm tra đã có user chưa
            const userCheck = await pool.query("SELECT id FROM users WHERE email = $1", [email]);
            if (userCheck.rows.length === 0) {
                await pool.query("INSERT INTO users (firebase_uid, email, role) VALUES ($1, $2, 'Salon_Freelancers')", [uid, email]);
            }
            return res.status(200).json({ role: "Salon_Freelancers" });
        }

        // 6️⃣ Nếu không thuộc nhóm nào ➜ mặc định là Crypto
        await pool.query("INSERT INTO users (firebase_uid, email, role) VALUES ($1, $2, 'Crypto')", [uid, email]);
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
// ✅ API: Ghi danh Salon_Customer nếu chưa có
router.post("/register-customer", verifyToken, async (req, res) => {
    const { uid, email, name, phone_number } = req.user;

    try {
        // 1️⃣ Check user trong bảng users
        const userRes = await pool.query(
            "SELECT id, role FROM users WHERE firebase_uid = $1",
            [uid]
        );

        if (userRes.rows.length === 0) {
            // Chưa có ➝ thêm mới với role Salon_Customer
            await pool.query(
                `INSERT INTO users (firebase_uid, email, role)
         VALUES ($1, $2, 'Salon_Customer')`,
                [uid, email]
            );
        } else if (userRes.rows[0].role !== "Salon_Customer") {
            // Đã có nhưng role khác ➝ cập nhật lại role
            await pool.query(
                `UPDATE users SET role = 'Salon_Customer' WHERE firebase_uid = $1`,
                [uid]
            );
        }

        // 2️⃣ Check & thêm vào bảng customers
        const customerCheck = await pool.query(
            "SELECT id FROM customers WHERE firebase_uid = $1",
            [uid]
        );

        if (customerCheck.rows.length === 0) {
            await pool.query(
                `INSERT INTO customers (firebase_uid, email, name, phone, status)
         VALUES ($1, $2, $3, $4, 'active')`,
                [uid, email, name || "", phone_number || ""]
            );
        }

        return res.status(201).json({ message: "✅ Customer registered or updated." });
    } catch (err) {
        console.error("❌ Error registering Salon_Customer:", err.message);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

export default router;
