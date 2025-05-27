import { Resend } from 'resend';
const resend = new Resend(process.env.RESEND_API_KEY);

export async function sendBookingEmail({ to, customerName, stylistName, dateTime, salonName, services }) {
  const serviceList = services.map(s => `• ${s.name} – $${s.price} / ${s.duration_minutes} mins`).join("<br/>");

  const html = `
    <div style="font-family: 'Segoe UI', sans-serif; line-height: 1.6; color: #111; background: linear-gradient(to bottom right, #ec4899, #fbbf24, #10b981); padding: 2rem; border-radius: 12px; color: white; box-shadow: 0 8px 20px rgba(0,0,0,0.1);">
      <h2 style="margin-top: 0; font-size: 1.8rem; color: #fff;">💅 Appointment Request Sent!</h2>
      <p>Hi <strong>${customerName}</strong>,</p>
      <p>Thank you for booking with <strong>${stylistName}</strong> at <strong>${salonName}</strong>.</p>
      <p>📅 <strong>Date & Time:</strong> ${dateTime}</p>
      <p>💼 <strong>Services:</strong><br/>${serviceList}</p>

      <div style="margin: 24px 0; padding: 16px; background: rgba(255, 255, 255, 0.15); border-left: 4px solid #fff; border-radius: 8px;">
        <p><strong>⏳ What happens next?</strong></p>
        <ul style="margin: 0; padding-left: 1rem;">
          <li>Our stylist has been notified about your request.</li>
          <li>You'll receive a confirmation email once the stylist accepts.</li>
          <li>Please check your inbox for real-time updates.</li>
        </ul>
      </div>

      <p>⚠ Note: This is an automated message from OneTool. Please do not reply.</p>

      <p style="margin-top: 2rem; font-size: 0.9rem; color: #f1f5f9;">
        — Sent from <strong>OneTool Salon</strong> • Bringing stylists & customers together 💖
      </p>
    </div>
  `;

  const text = `
Hi ${customerName},

Thanks for booking with ${stylistName} at ${salonName}.

🕒 Date & Time: ${dateTime}
💅 Services:
${services.map(s => `- ${s.name}: $${s.price}, ${s.duration_minutes} mins`).join("\n")}

What happens next?
• Your appointment has been sent to the stylist.
• You'll receive a confirmation email once they accept.
• Please check your inbox for updates.

— OneTool Salon Team
`;

  return resend.emails.send({
    from: 'OneTool Salon <noreply@onetool.it.com>',
    to,
    subject: `📩 Appointment request sent to ${stylistName}`,
    html,
    text
  });
}
