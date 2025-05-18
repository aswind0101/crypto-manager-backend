import express from "express";
import verifyToken from "../middleware/verifyToken.js";
import paypal from '@paypal/checkout-server-sdk';
import client from "../utils/paypal.js";

const router = express.Router();

router.post("/create-subscription", verifyToken, async (req, res) => {
  try {
    const request = new paypal.orders.OrdersCreateRequest();
    request.prefer("return=representation");
    request.requestBody({
      intent: "CAPTURE",
      purchase_units: [{
        amount: {
          currency_code: "USD",
          value: "10.00" // 💵 phí bạn muốn thu mỗi lần nhận khách
        },
        description: "Freelancer service charge"
      }],
      application_context: {
        brand_name: "CryptoManager",
        user_action: "PAY_NOW",
        return_url: `${process.env.FRONTEND_URL}/freelancers?paypal=success`,
        cancel_url: `${process.env.FRONTEND_URL}/freelancers?paypal=cancel`
      }
    });

    const order = await client.execute(request);
    const approvalUrl = order.result.links.find(link => link.rel === "approve")?.href;

    if (!approvalUrl) {
      return res.status(400).json({ error: "Failed to get approval URL" });
    }

    res.json({ url: approvalUrl });
  } catch (err) {
    console.error("❌ Error creating PayPal order:", err.message);
    res.status(500).json({ error: "PayPal order creation failed" });
  }
});

export default router;
