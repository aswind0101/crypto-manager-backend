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
// ✅ API: Lấy danh sách staff (filter theo salon, kỹ năng, rating)
router.get("/", verifyToken, async (req, res) => {
    const { salon_id, skill, min_rating } = req.query;

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
        WHERE 1=1
      `;

        const params = [];
        let count = 1;

        if (salon_id) {
            query += ` AND (s.salon_id = $${count} OR s.is_freelancer = TRUE)`;
            params.push(salon_id);
            count++;
        }

        if (skill) {
            query += ` AND s.skills::text ILIKE $${count}`;
            params.push(`%${skill}%`);
            count++;
        }

        if (min_rating) {
            query += ` AND s.rating >= $${count}`;
            params.push(min_rating);
            count++;
        }

        const result = await pool.query(query, params);

        res.json(result.rows);
    } catch (error) {
        console.error("Error fetching staff:", error.message);
        res.status(500).json({ error: "Failed to fetch staff" });
    }
});

// ✅ API: Xem chi tiết 1 staff theo ID
router.get("/:id", verifyToken, async (req, res) => {
    const { id } = req.params;

    try {
        const result = await pool.query(
            `SELECT s.id AS staff_id,
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
         WHERE s.id = $1`,
            [id]
        );

        if (result.rowCount === 0) {
            return res.status(404).json({ error: "Staff not found" });
        }

        res.json(result.rows[0]);
    } catch (error) {
        console.error("Error fetching staff detail:", error.message);
        res.status(500).json({ error: "Failed to fetch staff detail" });
    }
});


export default router;
