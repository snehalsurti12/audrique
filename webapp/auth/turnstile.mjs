/**
 * Cloudflare Turnstile server-side verification.
 * Uses native fetch — no npm dependency.
 */

const TURNSTILE_SECRET_KEY = process.env.TURNSTILE_SECRET_KEY || "";
const TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/**
 * Verify a Turnstile token server-side.
 *
 * @param {string} token - The cf-turnstile-response from the client
 * @param {string} [remoteIp] - Client IP (optional, improves accuracy)
 * @returns {Promise<{ success: boolean, error?: string }>}
 */
export async function verifyTurnstile(token, remoteIp) {
  if (!TURNSTILE_SECRET_KEY) {
    // Dev mode — skip verification when no secret key configured
    console.log("[turnstile] No TURNSTILE_SECRET_KEY set — skipping verification");
    return { success: true };
  }

  if (!token) {
    return { success: false, error: "Turnstile challenge not completed" };
  }

  try {
    const body = {
      secret: TURNSTILE_SECRET_KEY,
      response: token,
    };
    if (remoteIp) body.remoteip = remoteIp;

    const resp = await fetch(TURNSTILE_VERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const data = await resp.json();

    if (data.success) {
      return { success: true };
    }

    return {
      success: false,
      error: `Turnstile verification failed: ${(data["error-codes"] || []).join(", ")}`,
    };
  } catch (err) {
    console.error("[turnstile] Verification request failed:", err.message);
    return { success: false, error: "Turnstile verification unavailable" };
  }
}
