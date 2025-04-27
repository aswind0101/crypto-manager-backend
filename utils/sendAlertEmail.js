// utils/sendAlertEmail.js
import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY);

function formatMoney(number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(number);
}

export async function sendAlertEmail(toEmail, newProfitLoss, changePercent, portfolio) {
  const numericChange = Number(changePercent);
  const formattedChangePercent = (numericChange >= 0 ? "+" : "") + numericChange + "%";
  
  const isProfit = newProfitLoss >= 0;
  const emoji = isProfit ? "🟢" : "🔴";
  const statusText = isProfit ? "Profit" : "Loss";

  const subject = `${emoji} ${statusText} Alert: ${formatMoney(newProfitLoss)} (${formattedChangePercent})`;

  const coinDetails = portfolio
    .map(coin => {
      const netInvested = coin.total_invested - coin.total_sold;
      const realProfitLoss = coin.current_price * coin.total_quantity - netInvested;
      const profitPercent = netInvested > 0 ? ((realProfitLoss / netInvested) * 100).toFixed(1) : null;
      const emoji = realProfitLoss >= 0 ? "🟢" : "🔴";
      const profitText = profitPercent !== null ? (realProfitLoss >= 0 ? `+${profitPercent}%` : `${profitPercent}%`) : "N/A";

      return `<li>${emoji} <strong>${coin.coin_symbol.toUpperCase()}</strong>: ${formatMoney(realProfitLoss)} (${profitText})</li>`;
    })
    .join("");

  const html = `
    <h2>📢 Crypto Manager Notification</h2>
    <p>
      You are currently <strong>${isProfit ? 'making a profit' : 'at a loss'}</strong> of <strong>${formatMoney(newProfitLoss)}</strong>
      (${formattedChangePercent}).
    </p>
    <h3>📊 Breakdown:</h3>
    <ul style="padding-left:16px;margin-top:8px;margin-bottom:8px;">${coinDetails}</ul>
    <p style="font-size: 12px; color: #666;">— Sent by Crypto Manager (resend.com)</p>
  `;

  try {
    const data = await resend.emails.send({
      from: 'Crypto Manager <onboarding@resend.dev>',
      to: toEmail,
      subject,
      html
    });

    console.log("✅ Resend email sent:", data.id);
  } catch (error) {
    console.error("❌ Resend error:", error.message || error);
  }
}
