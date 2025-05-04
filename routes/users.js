// /backend/routes/users.js
import express from 'express';
import verifyToken from '../middleware/verifyToken.js';
import pkg from 'pg';
const { Pool } = pkg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const router = express.Router();

// Tạo user mới (dùng khi đăng ký)
router.post('/', verifyToken, async (req, res) => {
  try {
    const { firebase_uid, full_name, email, phone, role } = req.body;

    // Kiểm tra user đã tồn tại chưa
    const existingUser = await pool.query(
      'SELECT * FROM users WHERE firebase_uid = $1',
      [firebase_uid]
    );
    if (existingUser.rows.length > 0) {
      return res.status(400).json({ error: 'User đã tồn tại' });
    }

    // Insert user mới
    const newUser = await pool.query(
      'INSERT INTO users (firebase_uid, full_name, email, phone, role) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [firebase_uid, full_name, email, phone, role]
    );

    res.json(newUser.rows[0]);
  } catch (err) {
    console.error('Lỗi khi tạo user:', err);
    res.status(500).json({ error: 'Lỗi khi tạo user' });
  }
});

export default router;
