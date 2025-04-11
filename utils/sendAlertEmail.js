import nodemailer from "nodemailer";

export async function sendAlertEmail(toEmail, newProfitLoss, changePercent, portfolio) {
  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: process.env.ALERT_EMAIL_SENDER,
      pass: process.env.ALERT_EMAIL_PASSWORD
    }
  });

  // Format chi tiết coin lời/lỗ
  const coinDetails = portfolio
    .map(coin => {
      const profit = coin.profit_loss.toFixed(2);
      const emoji = coin.profit_loss >= 0 ? "🟢" : "🔴";
      return `<li>${emoji} <strong>${coin.coin_symbol.toUpperCase()}</strong>: ${profit} USD</li>`;
    })
    .join("");

  const mailOptions = {
    from: `"Crypto Manager" <${process.env.ALERT_EMAIL_SENDER}>`,
    to: toEmail,
    subject: "📈 Crypto Manager Profit/Loss Alert",
    html: `
      <p>👋 Hello!</p>
      <p>Your total profit/loss has changed by <strong>${changePercent}%</strong>.</p>
      <p><strong>Total Profit/Loss:</strong> <span style="color:${newProfitLoss >= 0 ? 'green' : 'red'}">
        ${newProfitLoss.toFixed(2)} USD</span></p>
      <h3 style="margin-top: 20px;">📊 Portfolio Breakdown:</h3>
      <ul style="padding-left: 20px; font-family: monospace; font-size: 14px;">
        ${coinDetails}
      </ul>
      <p style="margin-top: 20px;">– Crypto Manager Bot 🤖</p>
    `
  };

  await transporter.sendMail(mailOptions);
}
