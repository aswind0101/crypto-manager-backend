import express from "express";
import verifyToken from "../middleware/verifyToken.js";
import pkg from "pg";
const { Pool } = pkg;
const router = express.Router();
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
});

// POST: Save appointment invoice
router.post("/", verifyToken, async (req, res) => {
    const {
        appointment_id,
        customer_name,
        customer_phone,
        stylist_id,
        stylist_name,
        salon_id,
        services,
        total_amount,
        total_duration,
        actual_start_at,
        actual_end_at,
        notes
    } = req.body;

    if (!appointment_id || !services || !total_amount || !actual_end_at) {
        return res.status(400).json({ error: "Missing required fields." });
    }

    try {
        const result = await pool.query(
            `INSERT INTO appointment_invoices 
            (appointment_id, customer_name, customer_phone, stylist_id, stylist_name, salon_id, services, total_amount, total_duration, actual_start_at, actual_end_at, notes)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
            RETURNING *`,
            [
                appointment_id, customer_name, customer_phone, stylist_id, stylist_name, salon_id,
                JSON.stringify(services), total_amount, total_duration, actual_start_at, actual_end_at, notes
            ]
        );
        // Update appointment status
        await pool.query(
            `UPDATE appointments SET status='completed', end_at=$1 WHERE id=$2`,
            [actual_end_at, appointment_id]
        );
        res.json(result.rows[0]);
    } catch (err) {
        console.error("❌ Error saving invoice:", err.message);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

export default router;
