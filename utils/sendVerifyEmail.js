import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY);
const APP_BASE_URL = "https://onetool.it.com"
export async function sendVerifyEmail({ to, name, token }) {
  const link = `${APP_BASE_URL}/verify?token=${token}`;

  const html = `
    <div style="font-family: sans-serif; line-height: 1.5;">
      <h2>🔐 Welcome, ${name}!</h2>
      <p>Thanks for registering on our platform.</p>
      <p>Please click the button below to verify your email:</p>
      <p>
        <a href="${link}" style="display:inline-block;padding:10px 20px;background:#10b981;color:#fff;border-radius:6px;text-decoration:none;">
          ✅ Verify my account
        </a>
      </p>
      <p style="font-size: 12px; color: #666;">If you didn’t register, you can ignore this email.</p>
    </div>
  `;

  try {
    const result = await resend.emails.send({
      from: 'Nails & Hair <noreply@onetool.it.com>',
      to,
      subject: '🧾 Please verify your email',
      html
    });

    console.log("✅ Email sent to:", to);
    return true;
  } catch (error) {
    console.error("❌ Resend send error:", error.message || error);
    return false;
  }
}
