import { Resend } from 'resend';
const resend = new Resend(process.env.RESEND_API_KEY);

const STATUS_LABELS = {
  confirmed: {
    subject: "✅ Your appointment is confirmed!",
    heading: "✅ Appointment Confirmed",
    color: "#10b981",
    message: "Your appointment with <strong>{stylistName}</strong> at <strong>{salonName}</strong> has just been <strong>confirmed</strong>.",
    note: "Please arrive 5–10 minutes early and contact the stylist if needed. 🎉",
    text: "Please arrive early and get ready!"
  },
  cancelled: {
    subject: "❌ Your appointment has been cancelled",
    heading: "❌ Appointment Cancelled",
    color: "#dc2626",
    message: "Your appointment with <strong>{stylistName}</strong> at <strong>{salonName}</strong> has just been <strong>cancelled</strong>.",
    note: "If this cancellation was unexpected, you may rebook using the app anytime.",
    text: "You may rebook anytime via the app."
  }
};

export async function sendAppointmentStatusEmail({ to, customerName, stylistName, status, dateTime, salonName, services }) {
  // Chỉ gửi nếu status hợp lệ
  if (!["confirmed", "cancelled"].includes(status)) return;

  const config = STATUS_LABELS[status];

  const serviceList = services.map(s =>
    `<li><strong>${s.name}</strong> – $${s.price} / ${s.duration_minutes} mins</li>`
  ).join("");

  // Thay thế {stylistName}, {salonName} trong message
  const mainMsg = config.message
    .replace("{stylistName}", stylistName)
    .replace("{salonName}", salonName);

  const html = `
    <div style="max-width:600px;margin:auto;font-family:'Segoe UI',sans-serif;background:#fff;border:2px solid ${config.color};border-radius:16px;padding:24px;color:#111;">
      <h2 style="margin-top:0;font-size:24px;color:${config.color};">
        ${config.heading}
      </h2>
      <p>Hi <strong>${customerName}</strong>,</p>
      <p>${mainMsg}</p>
      <div style="background:#f9f9f9;padding:16px;border-radius:12px;margin:20px 0;">
        <p style="margin:0;">📅 <strong>Date & Time:</strong> ${dateTime}</p>
        <ul style="margin:10px 0 0 20px;padding:0;">${serviceList}</ul>
      </div>
      <p>${config.note}</p>
      <p style="margin:24px 0 8px 0;font-size:13px;color:#666;">
        — OneTool Salon Team
      </p>
    </div>
  `;

  const text = `
Hi ${customerName},

${mainMsg.replace(/<[^>]+>/g, '')}

Date & Time: ${dateTime}
Services:
${services.map(s => `- ${s.name}: $${s.price}, ${s.duration_minutes} mins`).join("\n")}

${config.text}

— OneTool Salon
`;

  return resend.emails.send({
    from: 'OneTool Salon <support@onetool.it.com>',
    to,
    subject: config.subject,
    html,
    text
  });
}
