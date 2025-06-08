// 📁 routes/payment.js
import express from "express";
import Stripe from "stripe";
import verifyToken from "../middleware/verifyToken.js";
import pkg from "pg";
const { Pool } = pkg;

const router = express.Router();
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// 1. API tạo Stripe SetupIntent và trả về client_secret
router.post("/stripe/setup-intent", verifyToken, async (req, res) => {
  const { uid, email } = req.user;
  try {
    // 1. Kiểm tra có Stripe customer chưa, nếu chưa thì tạo
    let freelancer = await pool.query("SELECT stripe_customer_id FROM freelancers WHERE firebase_uid = $1", [uid]);
    let customerId = freelancer.rows[0]?.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({ email });
      customerId = customer.id;
      await pool.query("UPDATE freelancers SET stripe_customer_id = $1 WHERE firebase_uid = $2", [customerId, uid]);
    }

    // 2. Tạo SetupIntent cho customer
    const setupIntent = await stripe.setupIntents.create({
      customer: customerId,
      payment_method_types: ["card"],
    });

    res.json({ client_secret: setupIntent.client_secret });
  } catch (err) {
    console.error("❌ SetupIntent error:", err.message);
    res.status(500).json({ error: "Failed to create SetupIntent" });
  }
});

// 2. Lưu payment_method_id sau khi hoàn thành (nếu cần)
router.post("/stripe/save-payment-method", verifyToken, async (req, res) => {
  const { uid } = req.user;
  const { payment_method_id } = req.body;
  if (!payment_method_id) return res.status(400).json({ error: "Missing payment_method_id" });

  try {
    // Gán payment method vào Stripe customer (attach)
    let freelancer = await pool.query("SELECT stripe_customer_id FROM freelancers WHERE firebase_uid = $1", [uid]);
    const customerId = freelancer.rows[0]?.stripe_customer_id;
    await stripe.paymentMethods.attach(payment_method_id, { customer: customerId });
    await stripe.customers.update(customerId, { invoice_settings: { default_payment_method: payment_method_id } });

    // Lưu vào DB để charge sau này
    await pool.query("UPDATE freelancers SET stripe_payment_method_id = $1 WHERE firebase_uid = $2", [payment_method_id, uid]);
    res.json({ success: true });
  } catch (err) {
    console.error("❌ Save payment method error:", err.message);
    res.status(500).json({ error: "Failed to save payment method" });
  }
});

export default router;
