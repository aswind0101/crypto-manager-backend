import nodemailer from "nodemailer";

export async function sendAlertEmail(toEmail, newProfitLoss, changePercent) {
  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: process.env.ALERT_EMAIL_SENDER,
      pass: process.env.ALERT_EMAIL_PASSWORD
    }
  });

  const mailOptions = {
    from: `"Crypto Manager" <${process.env.ALERT_EMAIL_SENDER}>`,
    to: toEmail,
    subject: "📈 Crypto Manager Profit/Loss Alert",
    html: `
      <p>Hi there,</p>
      <p>Your total profit/loss has changed by <strong>${changePercent}%</strong>.</p>
      <p>New Profit/Loss: <strong>$${newProfitLoss.toFixed(2)}</strong></p>
      <p>Keep track of your portfolio in Crypto Manager!</p>
      <p>🚀 Crypto Manager Bot</p>
    `
  };

  await transporter.sendMail(mailOptions);
}
