import express from "express";
import verifyToken from "../middleware/verifyToken.js";
import paypal from '@paypal/checkout-server-sdk';
import client from "../utils/paypal.js";
import pkg from "pg";
import axios from "axios";

const { Pool } = pkg;
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
});

const router = express.Router();

router.post("/create-subscription", verifyToken, async (req, res) => {
    const { uid } = req.user;

    try {
        // Lấy access token từ PayPal
        const authRes = await axios({
            method: "post",
            url: "https://api-m.paypal.com/v1/oauth2/token",
            headers: {
                "Content-Type": "application/x-www-form-urlencoded",
            },
            auth: {
                username: process.env.PAYPAL_CLIENT_ID,
                password: process.env.PAYPAL_CLIENT_SECRET,
            },
            data: "grant_type=client_credentials",
        });

        const accessToken = authRes.data.access_token;

        // Gọi API tạo subscription
        const result = await axios({
            method: "post",
            url: "https://api-m.paypal.com/v1/billing/subscriptions",
            headers: {
                Authorization: `Bearer ${accessToken}`,
                "Content-Type": "application/json",
            },
            data: {
                plan_id: process.env.PAYPAL_PLAN_ID,
                application_context: {
                    brand_name: "CryptoManager",
                    return_url: `${process.env.FRONTEND_URL}/freelancers?paypal=success`,
                    cancel_url: `${process.env.FRONTEND_URL}/freelancers?paypal=cancel`,
                    user_action: "SUBSCRIBE_NOW",
                },
            },
        });

        const approvalUrl = result.data.links.find(link => link.rel === "approve")?.href;

        if (!approvalUrl) return res.status(400).json({ error: "Failed to get approval link" });

        res.json({ url: approvalUrl });
    } catch (err) {
        console.error("❌ Error creating subscription:", err.message);
        res.status(500).json({ error: "Subscription creation failed" });
    }
});
router.post("/save-subscription", verifyToken, async (req, res) => {
  const { uid } = req.user;
  const { subscription_id } = req.body;

  if (!subscription_id) return res.status(400).json({ error: "Missing subscription ID" });

  try {
    await pool.query(
      `UPDATE freelancers 
       SET paypal_subscription_id = $1, paypal_connected = true 
       WHERE firebase_uid = $2`,
      [subscription_id, uid]
    );

    res.json({ message: "✅ Subscription saved successfully" });
  } catch (err) {
    console.error("❌ Error saving subscription:", err.message);
    res.status(500).json({ error: "Failed to save subscription" });
  }
});

export default router;