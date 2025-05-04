// ==== backend/middleware/verifyToken.js ====
import admin from "../firebaseAdmin.js";
import pkg from "pg";
const { Pool } = pkg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const verifyToken = async (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Missing or invalid token" });
  }

  const token = authHeader.split(" ")[1];

  try {
    const decodedToken = await admin.auth().verifyIdToken(token);
    const firebase_uid = decodedToken.uid;

    // 🔥 Truy vấn DB để lấy role + salon_id
    const result = await pool.query(
      `SELECT id, role, salon_id FROM users WHERE firebase_uid = $1`,
      [firebase_uid]
    );

    if (result.rowCount === 0) {
      return res.status(401).json({ error: "User not found in database" });
    }

    const user = result.rows[0];

    // ✅ Giữ lại toàn bộ decodedToken + thêm role info
    req.user = {
      ...decodedToken,             // vẫn giữ các trường email, name, picture...
      db_id: user.id,              // id trong bảng users
      role: user.role,             // 'customer' / 'staff' / 'owner'
      salon_id: user.salon_id      // NULL nếu freelancer hoặc khách
    };

    next();
  } catch (error) {
    console.error("Token verification failed:", error.message);
    res.status(401).json({ error: "Unauthorized" });
  }
};

export default verifyToken;
