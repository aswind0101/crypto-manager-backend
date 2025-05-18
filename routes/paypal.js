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

router.post("/create-subscription", verifyToken, async (req, res) => {
  const { uid } = req.user;
  const returnUrl = `${process.env.FRONTEND_URL}/freelancers?paypal=success`;
  const cancelUrl = `${process.env.FRONTEND_URL}/freelancers?paypal=cancel`;

  try {
    const request = new paypal.subscriptions.SubscriptionCreateRequest();
    request.requestBody({
      plan_id: process.env.PAYPAL_PLAN_ID, // ✅ plan ID bạn đã tạo
      application_context: {
        brand_name: "CryptoManager",
        locale: "en-US",
        shipping_preference: "NO_SHIPPING",
        user_action: "SUBSCRIBE_NOW",
        return_url: returnUrl,
        cancel_url: cancelUrl,
      }
    });

    const subscription = await client.execute(request);
    const approvalUrl = subscription.result.links.find(link => link.rel === "approve")?.href;

    res.json({ url: approvalUrl });
  } catch (err) {
    console.error("❌ Error creating subscription:", err.message);
    res.status(500).json({ error: "Subscription creation failed" });
  }
});

export default router;