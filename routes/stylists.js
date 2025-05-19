import express from "express";
import pkg from "pg";
const { Pool } = pkg;

const router = express.Router();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ✅ API: Lấy danh sách stylist đang online và có salon
router.get("/stylists/online", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
  f.id,
  f.name,
  f.avatar_url,
  f.gender,
  f.specialization,
  f.rating,
  s.latitude,
  s.longitude,
  s.name AS salon_name,
  s.address AS salon_address
FROM freelancers f
JOIN salons s ON f.salon_id = s.id
WHERE 
  f.is_verified = true AND
  f.status = 'active' AND
  f.avatar_url IS NOT NULL AND
  s.latitude IS NOT NULL AND
  s.longitude IS NOT NULL
ORDER BY f.name ASC
    `);

    res.json(result.rows);
  } catch (err) {
    console.error("❌ Error fetching online stylists:", err.message);
    res.status(500).json({ error: "Failed to fetch stylists" });
  }
});

export default router;
