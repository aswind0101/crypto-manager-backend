import express from "express";
import verifyToken from "../middleware/verifyToken.js";
import paypal from '@paypal/checkout-server-sdk';
import client from "../utils/paypal.js";
import pkg from "pg";

const { Pool } = pkg;
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
});

const router = express.Router();

// ✅ Gửi clientId cho frontend
router.get("/client-id", (req, res) => {
    res.json({ clientId: process.env.PAYPAL_CLIENT_ID });
});

// ✅ Lưu vault token sau khi freelancer kết nối PayPal
router.post("/save-token", verifyToken, async (req, res) => {
    const { uid } = req.user;
    const { paypal_token } = req.body;

    if (!paypal_token) return res.status(400).json({ error: "Missing token" });

    try {
        await pool.query(
            "UPDATE freelancers SET paypal_token = $1, paypal_connected = true WHERE firebase_uid = $2",
            [paypal_token, uid]
        );
        res.json({ message: "PayPal token saved successfully" });
    } catch (err) {
        console.error("❌ Error saving PayPal token:", err.message);
        res.status(500).json({ error: "Failed to save token" });
    }
});

export default router;
