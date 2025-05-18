// routes/paypal.js
import express from "express";
import client from "../utils/paypal.js";
import verifyToken from "../middleware/verifyToken.js";

const router = express.Router();

router.post("/create-billing", verifyToken, async (req, res) => {
  try {
    const request = new paypal.subscriptions.PlansCreateRequest();
    request.requestBody({
      product_id: process.env.PAYPAL_PRODUCT_ID, // bạn cần tạo Product trước
      name: "Freelancer Service Fee",
      billing_cycles: [{
        frequency: { interval_unit: "MONTH", interval_count: 1 },
        tenure_type: "REGULAR",
        sequence: 1,
        total_cycles: 0,
        pricing_scheme: {
          fixed_price: { value: "10.00", currency_code: "USD" }
        }
      }],
      payment_preferences: {
        auto_bill_outstanding: true,
        setup_fee: { value: "0", currency_code: "USD" },
        setup_fee_failure_action: "CONTINUE",
        payment_failure_threshold: 1
      }
    });

    const plan = await client.execute(request);

    // redirect URL sẽ được xử lý sau khi bạn tạo subscription
    const agreementURL = `https://www.paypal.com/billing/plans/${plan.result.id}`;

    res.json({ url: agreementURL });
  } catch (err) {
    console.error("❌ PayPal billing error:", err.message);
    res.status(500).json({ error: "Failed to create billing agreement" });
  }
});

export default router;
