import { Resend } from 'resend';
const resend = new Resend(process.env.RESEND_API_KEY);

export async function sendAppointmentStatusEmail({ to, customerName, stylistName, status, dateTime, salonName, services }) {
  const serviceList = services.map(s =>
    `<li><strong>${s.name}</strong> – $${s.price} / ${s.duration_minutes} mins</li>`
  ).join("");

  const html = `
  <div style="max-width: 600px; margin: auto; font-family: 'Segoe UI', sans-serif; background: #fff; border: 2px solid #10b981; border-radius: 16px; padding: 24px; color: #111;">
    <h2 style="margin-top: 0; font-size: 24px; color: ${status === "confirmed" ? "#10b981" : "#dc2626"};">
      ${status === "confirmed" ? "✅ Appointment Confirmed" : "❌ Appointment Cancelled"}
    </h2>

    <p>Hi <strong>${customerName}</strong>,</p>
    <p>Your appointment with <strong>${stylistName}</strong> at <strong>${salonName}</strong> has just been <strong>${status}</strong>.</p>

    <div style="background: #f9f9f9; padding: 16px; border-radius: 12px; margin: 20px 0;">
      <p style="margin: 0;">📅 <strong>Date & Time:</strong> ${dateTime}</p>
      <ul style="margin: 10px 0 0 20px; padding: 0;">${serviceList}</ul>
    </div>

    ${status === "confirmed" 
      ? "<p>Please arrive 5–10 minutes early and contact the stylist if needed. 🎉</p>"
      : "<p>If this cancellation was unexpected, you may rebook using the app anytime.</p>"
    }

    <p style="margin: 24px 0 8px 0; font-size: 13px; color: #666;">
      — OneTool Salon Team
    </p>
  </div>
  `;

  const text = `
Hi ${customerName},

Your appointment with ${stylistName} at ${salonName} has been ${status}.

Date & Time: ${dateTime}
Services:
${services.map(s => `- ${s.name}: $${s.price}, ${s.duration_minutes} mins`).join("\n")}

${status === "confirmed"
    ? "Please arrive early and get ready!"
    : "You may rebook anytime via the app."}

— OneTool Salon
`;

  return resend.emails.send({
    from: 'OneTool Salon <support@onetool.it.com>',
    to,
    subject: status === "confirmed"
      ? `✅ Your appointment is confirmed!`
      : `❌ Your appointment has been cancelled`,
    html,
    text
  });
}
