import { Resend } from 'resend';
const resend = new Resend(process.env.RESEND_API_KEY);

export async function sendBookingEmail({ to, customerName, stylistName, dateTime, salonName, services }) {
    const serviceList = services.map(s =>
        `<li><strong>${s.name}</strong> – $${s.price} / ${s.duration_minutes} mins</li>`
    ).join("");

    const html = `
  <div style="max-width: 600px; margin: auto; font-family: 'Segoe UI', sans-serif; background: linear-gradient(to bottom right, #ec4899, #fbbf24, #10b981); border-radius: 16px; padding: 24px; color: #fff; box-shadow: 0 6px 24px rgba(0,0,0,0.1);">
    <h2 style="margin-top: 0; font-size: 24px;">📩 Appointment Request Sent</h2>
    <p style="margin: 12px 0;">Hi <strong>${customerName}</strong>,</p>
    <p style="margin: 12px 0;">You've requested an appointment with <strong>${stylistName}</strong> at <strong>${salonName}</strong>.</p>
    
    <div style="background: rgba(255, 255, 255, 0.15); padding: 16px; border-radius: 12px; margin: 20px 0;">
      <p style="margin: 0;">📅 <strong>Date & Time:</strong> ${dateTime}</p>
      <ul style="margin: 10px 0 0 20px; padding: 0;">${serviceList}</ul>
    </div>

    <p style="margin: 16px 0;">
      ⏳ The stylist has been notified and will confirm your appointment shortly.<br/>
      📥 You will receive an email update once it's confirmed.
    </p>

    <p style="margin: 24px 0 8px 0; font-size: 13px; color: #f1f5f9;">
      — Sent from <strong>OneTool Salon</strong><br/>
      Bringing stylists & customers together 💖
    </p>
  </div>
  `;

    const text = `
Hi ${customerName},

You've requested an appointment with ${stylistName} at ${salonName}.

🕒 Date & Time: ${dateTime}

💅 Services:
${services.map(s => `- ${s.name}: $${s.price}, ${s.duration_minutes} mins`).join("\n")}

⏳ The stylist has been notified.
📥 You'll get an email once it's confirmed.

— OneTool Salon
`;

    return resend.emails.send({
        from: 'OneTool Salon <support@onetool.it.com>',
        to,
        subject: `📩 Your appointment request with ${stylistName}`,
        html,
        text
    });
}
