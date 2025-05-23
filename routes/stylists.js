// 📁 routes/stylists.js
import express from "express";
import pkg from "pg";
const { Pool } = pkg;

const router = express.Router();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ✅ GET /api/stylists/online
router.get("/stylists/online", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        f.id AS stylist_id,
        f.name AS stylist_name,
        f.avatar_url,
        f.gender,
        f.specialization,
        f.rating,
        f.about AS description,
        s.id AS salon_id,
        s.name AS salon_name,
        s.address AS salon_address,
        s.latitude,
        s.longitude
      FROM freelancers f
      JOIN salons s ON f.salon_id = s.id
      WHERE 
        f.is_verified = true AND
        f.status = 'active' AND
        f.avatar_url IS NOT NULL AND
        f.isqualified = true AND
        s.latitude IS NOT NULL AND
        s.longitude IS NOT NULL
      ORDER BY s.id, f.name
    `);

    // Gom stylist theo salon_id
    const grouped = {};

    for (const row of result.rows) {
      const salonId = row.salon_id;

      if (!grouped[salonId]) {
        grouped[salonId] = {
          salon_id: salonId,
          salon_name: row.salon_name,
          salon_address: row.salon_address,
          latitude: row.latitude,
          longitude: row.longitude,
          stylists: [],
        };
      }

      // 🔍 Truy vấn dịch vụ tương ứng với stylist
      const servicesRes = await pool.query(
        `SELECT id, name, price FROM salon_services 
         WHERE salon_id = $1 AND specialization = $2 AND is_active = true 
         ORDER BY name`,
        [salonId, Array.isArray(row.specialization) ? row.specialization[0] : row.specialization]
      );

      grouped[salonId].stylists.push({
        id: row.stylist_id,
        name: row.stylist_name,
        avatar_url: row.avatar_url,
        gender: row.gender,
        specialization: row.specialization,
        rating: row.rating,
        description: row.description,
        salon_id: salonId,
        services: servicesRes.rows || [],
      });
    }

    const salons = Object.values(grouped);
    res.json(salons);
  } catch (err) {
    console.error("❌ Error fetching stylists:", err.message);
    res.status(500).json({ error: "Failed to fetch stylists" });
  }
});

export default router;
