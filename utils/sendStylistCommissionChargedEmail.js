// utils/sendStylistCommissionChargedEmail.js

import { Resend } from 'resend';
const resend = new Resend(process.env.RESEND_API_KEY);

export async function sendStylistCommissionChargedEmail({
  to,
  stylistName,
  appointmentId,
  dateTime,
  salonName,
  services,
  totalAmount,
  commission
}) {
  const serviceList = services.map(
    (s) =>
      `<li><strong>${s.name}</strong> – $${parseFloat(s.price).toFixed(2)} / ${s.duration_minutes} mins</li>`
  ).join("");

  const html = `
    <div style="max-width:600px;margin:auto;font-family:'Segoe UI',sans-serif;background:#fff;border:2px solid #10b981;border-radius:16px;padding:24px;color:#111;">
      <h2 style="margin-top:0;font-size:22px;color:#10b981;">
        💸 5% Service Commission Charged
      </h2>
      <p>Hi <strong>${stylistName}</strong>,</p>
      <p>Your appointment at <strong>${salonName}</strong> on <b>${dateTime}</b> (ID: <b>#${appointmentId}</b>) has just been <strong>confirmed</strong> and a <span style="color:#ef4444;">5% service commission</span> has been charged from your connected payment method.</p>
      <div style="background:#f9f9f9;padding:16px;border-radius:12px;margin:20px 0;">
        <p><strong>Total Amount:</strong> $${totalAmount.toFixed(2)}</p>
        <p><strong>Commission Charged (5%):</strong> $${commission.toFixed(2)}</p>
        <ul style="margin:10px 0 0 20px;padding:0;">${serviceList}</ul>
      </div>
      <p style="margin:24px 0 8px 0;font-size:13px;color:#666;">
        — OneTool Salon Team
      </p>
    </div>
    `;

  const text = `
Hi ${stylistName},

Your appointment at ${salonName} on ${dateTime} (ID: #${appointmentId}) has been confirmed.
A 5% service commission ($${commission.toFixed(2)}) has just been charged from your connected payment method.

Total amount: $${totalAmount.toFixed(2)}

— OneTool Salon
`;

  return resend.emails.send({
    from: 'OneTool Salon <support@onetool.it.com>',
    to,
    subject: '💸 5% Service Commission Charged',
    html,
    text
  });
}
