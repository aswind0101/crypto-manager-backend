import express from "express";
import Stripe from "stripe";
import verifyToken from "../middleware/verifyToken.js";
import pkg from "pg";

const { Pool } = pkg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const router = express.Router();

router.post("/connect", verifyToken, async (req, res) => {
  const { uid, email } = req.user;

  try {
    const result = await pool.query("SELECT stripe_account_id FROM freelancers WHERE firebase_uid = $1", [uid]);
    let accountId = result.rows[0]?.stripe_account_id;

    if (!accountId) {
      const account = await stripe.accounts.create({
        type: "express",
        email,
        capabilities: { transfers: { requested: true } }
      });
      accountId = account.id;

      await pool.query("UPDATE freelancers SET stripe_account_id = $1 WHERE firebase_uid = $2", [accountId, uid]);
    }

    const accountLink = await stripe.accountLinks.create({
      account: accountId,
      refresh_url: `${process.env.FRONTEND_URL}/freelancers`,
      return_url: `${process.env.FRONTEND_URL}/freelancers`,
      type: "account_onboarding",
    });

    res.json({ url: accountLink.url });
  } catch (err) {
    console.error("❌ Stripe connect error:", err.message);
    res.status(500).json({ error: "Stripe connect failed" });
  }
});

router.get("/status", verifyToken, async (req, res) => {
  const { uid } = req.user;
  try {
    const result = await pool.query("SELECT stripe_account_id FROM freelancers WHERE firebase_uid = $1", [uid]);
    const accountId = result.rows[0]?.stripe_account_id;

    if (!accountId) return res.json({ connected: false });

    const account = await stripe.accounts.retrieve(accountId);
    const isConnected = account.charges_enabled && account.details_submitted;

    res.json({ connected: isConnected });
  } catch (err) {
    console.error("❌ Stripe status error:", err.message);
    res.status(500).json({ error: "Stripe status check failed" });
  }
});

export default router;
