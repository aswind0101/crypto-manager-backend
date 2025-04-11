import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY);
// utils/sendAlertEmail.js

function formatMoney(number) {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    }).format(number);
  }
  

export async function sendAlertEmail(toEmail, newProfitLoss, changePercent, portfolio) {
  const coinDetails = portfolio
    .map(coin => {
      const profit = coin.profit_loss.toFixed(2);
      const emoji = coin.profit_loss >= 0 ? "🟢" : "🔴";
      return `<li>${emoji} <strong>${coin.coin_symbol.toUpperCase()}</strong>: ${formatMoney(profit)} USD</li>`;
    })
    .join("");

  const html = `
    <h2>📈 Profit/Loss Alert</h2>
    <p>Your profit/loss changed by <strong>${changePercent}%</strong>.</p>
    <p><strong>Total:</strong> ${formatMoney(newProfitLoss)} USD</p>
    <h3>📊 Breakdown:</h3>
    <ul>${coinDetails}</ul>
    <p style="font-size: 12px; color: #666;">— Sent by Crypto Manager (resend.com)</p>
  `;

  try {
    const data = await resend.emails.send({
      from: 'Crypto Manager <onboarding@resend.dev>',
      to: toEmail,
      subject: '📈 Profit/Loss Alert from Crypto Manager',
      html
    });

    console.log("✅ Resend email sent:", data.id);
  } catch (error) {
    console.error("❌ Resend error:", error.message || error);
  }
}
