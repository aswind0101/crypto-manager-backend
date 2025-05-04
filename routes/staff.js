// ==== backend/routes/staff.js ====
import express from "express";
const router = express.Router();

import verifyToken from "../middleware/verifyToken.js";
import checkRole from "../middleware/checkRole.js";
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

// ✅ API: Chủ salon chỉnh sửa thông tin nhân viên nội bộ
router.patch("/:id", verifyToken, checkRole(['owner']), async (req, res) => {
    const { id } = req.params;
    const {
        position,
        skills,
        certifications,
        experience_years,
        gender,
        rating,
        bio
    } = req.body;

    try {
        // 🔎 1️⃣ Kiểm tra staff có tồn tại & thuộc salon owner hay không
        const staffCheck = await pool.query(
            `SELECT * FROM staff WHERE id = $1`,
            [id]
        );

        if (staffCheck.rowCount === 0) {
            return res.status(404).json({ error: "Staff not found" });
        }

        const staff = staffCheck.rows[0];

        // ⚠️ Nếu là freelancer → không cho phép update
        if (staff.is_freelancer) {
            return res.status(403).json({ error: "Cannot edit freelancer profile" });
        }

        // ⚠️ Kiểm tra quyền: chỉ được chỉnh sửa nhân viên cùng salon
        if (staff.salon_id !== req.user.salon_id) {
            return res.status(403).json({ error: "You do not have permission to edit this staff" });
        }

        // 🔄 2️⃣ Update staff
        const result = await pool.query(
            `UPDATE staff
         SET position = COALESCE($1, position),
             skills = COALESCE($2, skills),
             certifications = COALESCE($3, certifications),
             experience_years = COALESCE($4, experience_years),
             gender = COALESCE($5, gender),
             rating = COALESCE($6, rating),
             bio = COALESCE($7, bio),
             updated_at = NOW()
         WHERE id = $8
         RETURNING *`,
            [
                position,
                skills,
                certifications,
                experience_years,
                gender,
                rating,
                bio,
                id
            ]
        );

        res.json(result.rows[0]);
    } catch (error) {
        console.error("Error updating staff:", error.message);
        res.status(500).json({ error: "Failed to update staff" });
    }
});

// ✅ API: Staff tự chỉnh sửa hồ sơ của chính mình
router.patch("/me/update-profile", verifyToken, checkRole(['staff']), async (req, res) => {
    const {
      position,
      skills,
      certifications,
      experience_years,
      gender,
      bio
    } = req.body;
  
    try {
      // 🔎 1️⃣ Tìm staff record theo user_id
      const staffCheck = await pool.query(
        `SELECT * FROM staff WHERE user_id = $1`,
        [req.user.db_id]
      );
  
      if (staffCheck.rowCount === 0) {
        return res.status(404).json({ error: "Staff profile not found" });
      }
  
      const staff = staffCheck.rows[0];
  
      // 🔄 2️⃣ Update staff profile
      const result = await pool.query(
        `UPDATE staff
         SET position = COALESCE($1, position),
             skills = COALESCE($2, skills),
             certifications = COALESCE($3, certifications),
             experience_years = COALESCE($4, experience_years),
             gender = COALESCE($5, gender),
             bio = COALESCE($6, bio),
             updated_at = NOW()
         WHERE user_id = $7
         RETURNING *`,
        [
          position,
          skills,
          certifications,
          experience_years,
          gender,
          bio,
          req.user.db_id
        ]
      );
  
      res.json(result.rows[0]);
    } catch (error) {
      console.error("Error updating own staff profile:", error.message);
      res.status(500).json({ error: "Failed to update profile" });
    }
  });
  

export default router;
