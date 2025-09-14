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

// Hiển thị giá đẹp mắt theo độ lớn của số
function formatPrice(n) {
  if (n === null || n === undefined || isNaN(Number(n))) return "N/A";
  const x = Number(n);
  if (x >= 1) return x.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (x >= 0.01) return x.toLocaleString("en-US", { minimumFractionDigits: 4, maximumFractionDigits: 4 });
  return x.toLocaleString("en-US", { minimumFractionDigits: 6, maximumFractionDigits: 6 });
}

// Cố gắng lấy current price từ nhiều trường khác nhau để tránh lệ thuộc 1 schema duy nhất
function getCurrentPrice(coin) {
  const candidates = [
    coin.current_price,
    coin.price,
    coin.market_price,
    coin.latest_price,
  ];

  // Thử tính price = current_value / quantity nếu có
  const qtyFields = ['total_quantity', 'quantity', 'amount', 'holdings', 'total_amount'];
  const val = Number(coin.current_value);
  for (const f of qtyFields) {
    const q = Number(coin[f]);
    if (!isNaN(val) && !isNaN(q) && q > 0) {
      candidates.push(val / q);
      break;
    }
  }

  for (const c of candidates) {
    const n = Number(c);
    if (!isNaN(n) && isFinite(n) && n > 0) return n;
  }
  return null;
}

export async function sendAlertEmail(toEmail, newProfitLoss, changePercent, portfolio) {
  const numericChange = Number(changePercent);
  const formattedChangePercent = (numericChange >= 0 ? "+" : "") + numericChange + "%";

  const isProfit = newProfitLoss >= 0;
  const emoji = isProfit ? "🟢" : "🔴";
  const statusText = isProfit ? "Profit" : "Loss";

  const subject = `${emoji} ${statusText} Alert: ${formatMoney(newProfitLoss)} (${formattedChangePercent})`;

  const coinDetails = (portfolio || [])
    .map(coin => {
      const symbol = (coin.coin_symbol || "").toString().toUpperCase();
      const netInvested = Number(coin.total_invested || 0) - Number(coin.total_sold || 0);
      const currentValue = Number(coin.current_value || 0);
      const realProfitLoss = currentValue - (isNaN(netInvested) ? 0 : netInvested);

      const profitPercent = netInvested > 0
        ? ((realProfitLoss / netInvested) * 100).toFixed(1)
        : null;

      const profitEmoji = realProfitLoss >= 0 ? "🟢" : "🔴";
      const profitText = profitPercent !== null
        ? (realProfitLoss >= 0 ? `+${profitPercent}%` : `${profitPercent}%`)
        : "N/A";

      const price = getCurrentPrice(coin);
      const priceText = price ? `$${formatPrice(price)}` : "N/A";

      return `
        <li style="margin:6px 0;">
          ${profitEmoji} <strong>${symbol}</strong>:
          ${formatMoney(realProfitLoss)} (${profitText})
          <span style="color:#666;">— Price: <strong>${priceText}</strong></span>
        </li>
      `;
    })
    .join("");

  const html = `
    <h2>📢 Crypto Manager Notification</h2>
    <p>
      You are currently <strong>${isProfit ? 'making a profit' : 'at a loss'}</strong> of
      <strong>${formatMoney(newProfitLoss)}</strong> (${formattedChangePercent}).
    </p>

    <h3>📊 Breakdown (with current prices):</h3>
    <ul style="padding-left:16px;margin-top:8px;margin-bottom:8px;">${coinDetails}</ul>

    <p style="font-size: 12px; color: #666; margin-top:16px;">— Sent by Crypto Manager (resend.com)</p>
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
