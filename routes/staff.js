// ==== backend/routes/staff.js ====
import express from "express";
const router = express.Router();

import verifyToken from "../middleware/verifyToken.js";
import pkg from "pg";
const { Pool } = pkg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ✅ 1️⃣ API: Lấy danh sách staff (cả nội bộ + freelancer)
router.get("/", verifyToken, async (req, res) => {
  const { salon_id } = req.query;  // option: lọc theo salon

  try {
    let query = `
      SELECT s.id AS staff_id,
             u.full_name,
             u.email,
             u.phone,
             s.position,
             s.is_freelancer,
             s.skills,
             s.certifications,
             s.experience_years,
             s.gender,
             s.rating,
             s.bio,
             s.created_at
      FROM staff s
      LEFT JOIN users u ON s.user_id = u.id
    `;

    let params = [];

    if (salon_id) {
      query += " WHERE s.salon_id = $1 OR s.is_freelancer = TRUE";
      params.push(salon_id);
    }

    const result = await pool.query(query, params);

    res.json(result.rows);
  } catch (error) {
    console.error("Error fetching staff:", error.message);
    res.status(500).json({ error: "Failed to fetch staff" });
  }
});

export default router;
