import { Resend } from 'resend';
const resend = new Resend(process.env.RESEND_API_KEY);

export async function sendBookingEmail({ to, customerName, stylistName, dateTime, salonName, services }) {
  const serviceList = services.map(s => `• ${s.name} – $${s.price} / ${s.duration_minutes} mins`).join("<br/>");

  const html = `
    <div style="font-family: 'Segoe UI', sans-serif; line-height: 1.6; color: #111;">
      <h2 style="color:#10b981;">📅 Appointment Booked!</h2>
      <p>Hi ${customerName}, your booking is confirmed with <strong>${stylistName}</strong> at <strong>${salonName}</strong>.</p>
      <p><strong>🕒 Date & Time:</strong> ${dateTime}</p>
      <p><strong>💅 Services:</strong><br/>${serviceList}</p>
      <hr style="margin: 32px 0; border: none; border-top: 1px solid #eee;">
      <p style="font-size: 12px; color: #666;">
        — Thank you for using OneTool • This is an automatic confirmation.
      </p>
    </div>
  `;

  return resend.emails.send({
    from: 'OneTool Salon <support@onetool.it.com>',
    to,
    subject: `✅ Appointment confirmed with ${stylistName}`,
    html
  });
}
