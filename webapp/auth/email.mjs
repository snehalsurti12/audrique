/**
 * Email sending — verification, password reset, and invitation emails.
 * Uses Resend API via native fetch. No npm dependency.
 *
 * When RESEND_API_KEY is not set (local dev), logs email content to console
 * including clickable links for manual testing.
 */

const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
const FROM_EMAIL = process.env.AUTH_FROM_EMAIL || "Audrique Studio <noreply@studio.audrique.com>";
const BASE_URL = process.env.AUTH_BASE_URL || "http://localhost:4200";

/**
 * Send an invitation email with a registration link.
 */
export async function sendInvitationEmail(email, token, inviterName, role) {
  const acceptUrl = `${BASE_URL}/register.html?invite=${token}`;
  return sendEmail({
    to: email,
    subject: `${inviterName} invited you to Audrique Studio`,
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 480px; margin: 0 auto;">
        <h2 style="color: #e2e8f0;">You're invited to Audrique Studio</h2>
        <p style="color: #94a3b8;">${inviterName} has invited you to join their team as a <strong>${role}</strong>.</p>
        <p><a href="${acceptUrl}" style="display: inline-block; background: linear-gradient(135deg, #6366f1, #818cf8); color: #fff; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: 600;">Accept Invitation</a></p>
        <p style="color: #64748b; font-size: 0.85rem;">This invitation expires in 7 days.</p>
        <p style="color: #64748b; font-size: 0.85rem;">If you didn't expect this invitation, you can safely ignore this email.</p>
      </div>
    `,
  });
}

/**
 * Send a password reset email.
 */
export async function sendPasswordResetEmail(email, token) {
  const resetUrl = `${BASE_URL}/reset-password.html?token=${token}`;
  return sendEmail({
    to: email,
    subject: "Reset your Audrique Studio password",
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 480px; margin: 0 auto;">
        <h2 style="color: #e2e8f0;">Password Reset</h2>
        <p style="color: #94a3b8;">Click the link below to reset your Audrique Studio password:</p>
        <p><a href="${resetUrl}" style="display: inline-block; background: linear-gradient(135deg, #6366f1, #818cf8); color: #fff; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: 600;">Reset Password</a></p>
        <p style="color: #64748b; font-size: 0.85rem;">This link expires in 1 hour.</p>
        <p style="color: #64748b; font-size: 0.85rem;">If you didn't request this, you can safely ignore this email.</p>
      </div>
    `,
  });
}

/**
 * Send an email verification link (used when admin creates user directly).
 */
export async function sendVerificationEmail(email, token, displayName) {
  const verifyUrl = `${BASE_URL}/verify-email.html?token=${token}`;
  return sendEmail({
    to: email,
    subject: "Verify your Audrique Studio email",
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 480px; margin: 0 auto;">
        <h2 style="color: #e2e8f0;">Welcome to Audrique Studio, ${displayName}!</h2>
        <p style="color: #94a3b8;">Click the link below to verify your email address:</p>
        <p><a href="${verifyUrl}" style="display: inline-block; background: linear-gradient(135deg, #6366f1, #818cf8); color: #fff; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: 600;">Verify Email</a></p>
        <p style="color: #64748b; font-size: 0.85rem;">This link expires in 24 hours.</p>
      </div>
    `,
  });
}

// ── Internal ─────────────────────────────────────────────────────────────────

async function sendEmail({ to, subject, html }) {
  if (!RESEND_API_KEY) {
    // Dev mode — log to console with clickable links
    console.log(`\n[email] ─────────────────────────────────────────────────`);
    console.log(`[email] To:      ${to}`);
    console.log(`[email] Subject: ${subject}`);
    // Extract first URL from HTML for easy copy-paste
    const urlMatch = html.match(/href="([^"]+)"/);
    if (urlMatch) {
      console.log(`[email] Link:    ${urlMatch[1]}`);
    }
    console.log(`[email] ─────────────────────────────────────────────────\n`);
    return;
  }

  try {
    const resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from: FROM_EMAIL, to, subject, html }),
    });

    if (!resp.ok) {
      const text = await resp.text();
      console.error(`[email] Failed to send to ${to}: ${resp.status} ${text}`);
    }
  } catch (err) {
    console.error(`[email] Send error for ${to}:`, err.message);
  }
}
