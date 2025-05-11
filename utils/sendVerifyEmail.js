import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY);
const APP_BASE_URL = "https://onetool.it.com";

export async function sendVerifyEmail({ to, name, token }) {
  const link = `${APP_BASE_URL}/verify?token=${token}`;

  const html = `
    <div style="font-family: 'Segoe UI', sans-serif; line-height: 1.6; color: #111;">
      <h2 style="color:#10b981;">🔐 Welcome, ${name}!</h2>
      <p>Thanks for registering on <strong>OneTool</strong>.</p>
      <p>Please click the button below to verify your email and activate your account:</p>
      <p style="margin: 24px 0;">
        <a href="${link}" style="display:inline-block;padding:12px 24px;background-color:#10b981;color:#fff;font-weight:bold;border-radius:8px;text-decoration:none;">
          ✅ Verify my account
        </a>
      </p>
      <p>If the button doesn't work, you can also copy and paste this link into your browser:</p>
      <p style="word-break: break-all;"><a href="${link}" style="color: #2563eb;">${link}</a></p>
      <hr style="margin: 32px 0; border: none; border-top: 1px solid #eee;">
      <p style="font-size: 12px; color: #666;">
        — Sent by OneTool Team • If you didn’t register, you can safely ignore this email.
      </p>
    </div>
  `;

  try {
    const result = await resend.emails.send({
      from: 'OneTool Team <support@onetool.it.com>',
      to,
      subject: '🧾 Verify your email to activate your account',
      html,
      text: `Hi ${name}, please verify your email to activate your account: ${link}`
    });

    console.log("✅ Verification email sent to:", to);
    return true;
  } catch (error) {
    console.error("❌ Resend error:", error.message || error);
    return false;
  }
}
