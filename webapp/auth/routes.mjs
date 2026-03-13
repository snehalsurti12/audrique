/**
 * Shared auth route handlers — used by both Studio server and Admin server.
 *
 * Routes:
 *   POST /api/auth/register    — Accept invitation and create account
 *   POST /api/auth/login       — Authenticate and issue tokens
 *   POST /api/auth/refresh     — Rotate refresh token, issue new access token
 *   POST /api/auth/logout      — Revoke refresh token
 *   POST /api/auth/forgot-password — Request password reset email
 *   POST /api/auth/reset-password  — Set new password via token
 *   GET  /api/auth/verify-email    — Verify email via token
 *   GET  /api/auth/me              — Get current user info
 *   PUT  /api/auth/me              — Update own profile (name, password)
 *   GET  /api/auth/invitation      — Get invitation details (for register page)
 */

import crypto from "node:crypto";
import { signAccessToken } from "./jwt.mjs";
import { hashPassword, verifyPassword, validatePasswordStrength } from "./password.mjs";
import { requireAuth } from "./middleware.mjs";
import { verifyTurnstile } from "./turnstile.mjs";
import { isFreeDomain } from "./email-blocklist.mjs";
import { sendPasswordResetEmail } from "./email.mjs";
import { getUserByEmail, getUserById, createUser, updateLastLogin, updateUserProfile, markEmailVerified } from "../db/queries/users.mjs";
import {
  generateToken, createRefreshToken, findRefreshToken, revokeRefreshToken,
  revokeAllUserRefreshTokens, createPasswordResetToken, usePasswordResetToken,
  getInvitation, acceptInvitation, createEmailVerifyToken, verifyEmailToken,
} from "../db/queries/auth-tokens.mjs";
import { logAttempt, checkBruteForce } from "../db/queries/login-attempts.mjs";
import { logAudit } from "../db/security.mjs";

const REFRESH_COOKIE_NAME = "audrique_refresh";

// ── Helpers ──────────────────────────────────────────────────────────────────

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch { reject(new Error("Invalid JSON body")); }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function getClientIp(req) {
  return req.headers["x-forwarded-for"]?.split(",")[0]?.trim()
    || req.socket.remoteAddress || "127.0.0.1";
}

function setRefreshCookie(res, token) {
  const maxAge = 7 * 24 * 60 * 60; // 7 days in seconds
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  res.setHeader("Set-Cookie",
    `${REFRESH_COOKIE_NAME}=${token}; HttpOnly; SameSite=Strict; Path=/api/auth/refresh; Max-Age=${maxAge}${secure}`
  );
}

function clearRefreshCookie(res) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  res.setHeader("Set-Cookie",
    `${REFRESH_COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/api/auth/refresh; Max-Age=0${secure}`
  );
}

function parseCookie(req, name) {
  const cookies = req.headers.cookie || "";
  const match = cookies.split(";").map(c => c.trim()).find(c => c.startsWith(`${name}=`));
  return match ? match.split("=")[1] : null;
}

function issueTokens(user) {
  const accessToken = signAccessToken({
    sub: user.id,
    tid: user.tenant_id,
    role: user.role,
    email: user.email,
  });
  const refreshToken = generateToken(48);
  return { accessToken, refreshToken };
}

// ── Route Handler ────────────────────────────────────────────────────────────

/**
 * Handle all /api/auth/* routes.
 * @returns {boolean} true if route was handled
 */
export async function handleAuthRoutes(req, res, pathname, url) {

  // ── POST /api/auth/register — accept invitation ─────────────────────────
  if (pathname === "/api/auth/register" && req.method === "POST") {
    try {
      const body = await parseBody(req);
      const { inviteToken, displayName, password, turnstileToken } = body;

      // Validate invite token
      if (!inviteToken) {
        return sendJson(res, 400, { error: "Invitation token is required" }), true;
      }
      const invitation = await getInvitation(inviteToken);
      if (!invitation) {
        return sendJson(res, 400, { error: "Invalid or expired invitation" }), true;
      }

      // Validate display name
      if (!displayName || displayName.trim().length < 2) {
        return sendJson(res, 400, { error: "Display name must be at least 2 characters" }), true;
      }

      // Validate password
      const pwError = validatePasswordStrength(password);
      if (pwError) {
        return sendJson(res, 400, { error: pwError }), true;
      }

      // Verify Turnstile
      const turnstileResult = await verifyTurnstile(turnstileToken, getClientIp(req));
      if (!turnstileResult.success) {
        return sendJson(res, 400, { error: turnstileResult.error }), true;
      }

      // Check email not already registered
      const existing = await getUserByEmail(invitation.email);
      if (existing) {
        return sendJson(res, 409, { error: "An account with this email already exists" }), true;
      }

      // Create user
      const passwordHash = await hashPassword(password);
      const user = await createUser({
        tenantId: invitation.tenant_id,
        email: invitation.email,
        passwordHash,
        displayName: displayName.trim(),
        role: invitation.role,
        emailVerified: true, // Invitation email proves ownership
        invitedBy: invitation.invited_by,
      });

      // Mark invitation as accepted
      await acceptInvitation(invitation.id);

      await logAudit(invitation.tenant_id, "user.registered", "user", user.id, {
        email: user.email, role: user.role,
      });

      sendJson(res, 201, { success: true, message: "Account created. You can now log in." });
    } catch (err) {
      console.error("[auth] Registration error:", err);
      sendJson(res, 500, { error: "Registration failed" });
    }
    return true;
  }

  // ── POST /api/auth/login ────────────────────────────────────────────────
  if (pathname === "/api/auth/login" && req.method === "POST") {
    try {
      const body = await parseBody(req);
      const { email, password } = body;
      const ip = getClientIp(req);

      if (!email || !password) {
        return sendJson(res, 400, { error: "Email and password are required" }), true;
      }

      // Brute force check
      const brute = await checkBruteForce(email, ip);
      if (brute.blocked) {
        return sendJson(res, 429, { error: brute.reason }), true;
      }

      // Look up user
      const user = await getUserByEmail(email);
      if (!user || !user.is_active) {
        await logAttempt(email, ip, false);
        return sendJson(res, 401, { error: "Invalid email or password" }), true;
      }

      if (!user.email_verified) {
        await logAttempt(email, ip, false);
        return sendJson(res, 401, { error: "Please verify your email before logging in" }), true;
      }

      // Compare password
      const match = await verifyPassword(password, user.password_hash);
      if (!match) {
        await logAttempt(email, ip, false);
        return sendJson(res, 401, { error: "Invalid email or password" }), true;
      }

      // Issue tokens
      const { accessToken, refreshToken } = issueTokens(user);
      await createRefreshToken(user.id, refreshToken, {
        ipAddress: ip,
        userAgent: req.headers["user-agent"],
      });
      await updateLastLogin(user.id);
      await logAttempt(email, ip, true);

      await logAudit(user.tenant_id, "user.login", "user", user.id, { ip });

      setRefreshCookie(res, refreshToken);
      sendJson(res, 200, {
        accessToken,
        user: {
          id: user.id,
          tenantId: user.tenant_id,
          displayName: user.display_name,
          email: user.email,
          role: user.role,
        },
      });
    } catch (err) {
      console.error("[auth] Login error:", err);
      sendJson(res, 500, { error: "Login failed" });
    }
    return true;
  }

  // ── POST /api/auth/refresh ──────────────────────────────────────────────
  if (pathname === "/api/auth/refresh" && req.method === "POST") {
    try {
      const rawToken = parseCookie(req, REFRESH_COOKIE_NAME);
      if (!rawToken) {
        return sendJson(res, 401, { error: "No refresh token" }), true;
      }

      const tokenRow = await findRefreshToken(rawToken);
      if (!tokenRow) {
        clearRefreshCookie(res);
        return sendJson(res, 401, { error: "Invalid or expired refresh token" }), true;
      }

      // Revoke old token (rotation)
      await revokeRefreshToken(tokenRow.id);

      // Get current user
      const user = await getUserById(tokenRow.user_id);
      if (!user || !user.is_active) {
        clearRefreshCookie(res);
        return sendJson(res, 401, { error: "Account disabled" }), true;
      }

      // Issue new tokens
      const { accessToken, refreshToken } = issueTokens(user);
      await createRefreshToken(user.id, refreshToken, {
        ipAddress: getClientIp(req),
        userAgent: req.headers["user-agent"],
      });

      setRefreshCookie(res, refreshToken);
      sendJson(res, 200, {
        accessToken,
        user: {
          id: user.id,
          tenantId: user.tenant_id,
          displayName: user.display_name,
          email: user.email,
          role: user.role,
        },
      });
    } catch (err) {
      console.error("[auth] Refresh error:", err);
      clearRefreshCookie(res);
      sendJson(res, 401, { error: "Refresh failed" });
    }
    return true;
  }

  // ── POST /api/auth/logout ───────────────────────────────────────────────
  if (pathname === "/api/auth/logout" && req.method === "POST") {
    try {
      const rawToken = parseCookie(req, REFRESH_COOKIE_NAME);
      if (rawToken) {
        const tokenRow = await findRefreshToken(rawToken);
        if (tokenRow) await revokeRefreshToken(tokenRow.id);
      }
      clearRefreshCookie(res);
      sendJson(res, 200, { success: true });
    } catch (err) {
      clearRefreshCookie(res);
      sendJson(res, 200, { success: true });
    }
    return true;
  }

  // ── POST /api/auth/forgot-password ──────────────────────────────────────
  if (pathname === "/api/auth/forgot-password" && req.method === "POST") {
    try {
      const body = await parseBody(req);
      const { email } = body;

      // Always return success (don't reveal if email exists)
      if (email) {
        const user = await getUserByEmail(email);
        if (user && user.is_active && user.email_verified) {
          const token = await createPasswordResetToken(user.id);
          await sendPasswordResetEmail(user.email, token);
        }
      }

      sendJson(res, 200, {
        success: true,
        message: "If an account with that email exists, we've sent a password reset link.",
      });
    } catch (err) {
      console.error("[auth] Forgot-password error:", err);
      sendJson(res, 200, { success: true, message: "If an account with that email exists, we've sent a password reset link." });
    }
    return true;
  }

  // ── POST /api/auth/reset-password ───────────────────────────────────────
  if (pathname === "/api/auth/reset-password" && req.method === "POST") {
    try {
      const body = await parseBody(req);
      const { token, password } = body;

      if (!token || !password) {
        return sendJson(res, 400, { error: "Token and new password are required" }), true;
      }

      const pwError = validatePasswordStrength(password);
      if (pwError) {
        return sendJson(res, 400, { error: pwError }), true;
      }

      const userId = await usePasswordResetToken(token);
      if (!userId) {
        return sendJson(res, 400, { error: "Invalid or expired reset link" }), true;
      }

      const passwordHash = await hashPassword(password);
      await updateUserProfile(userId, { passwordHash });

      // Force logout everywhere
      await revokeAllUserRefreshTokens(userId);

      sendJson(res, 200, { success: true, message: "Password updated. Please log in with your new password." });
    } catch (err) {
      console.error("[auth] Reset-password error:", err);
      sendJson(res, 500, { error: "Password reset failed" });
    }
    return true;
  }

  // ── GET /api/auth/verify-email ──────────────────────────────────────────
  if (pathname === "/api/auth/verify-email" && req.method === "GET") {
    try {
      const token = url.searchParams.get("token");
      if (!token) {
        return sendJson(res, 400, { error: "Token is required" }), true;
      }

      const userId = await verifyEmailToken(token);
      if (!userId) {
        return sendJson(res, 400, { error: "Invalid or expired verification link" }), true;
      }

      await markEmailVerified(userId);
      sendJson(res, 200, { success: true, message: "Email verified. You can now log in." });
    } catch (err) {
      console.error("[auth] Email verification error:", err);
      sendJson(res, 500, { error: "Verification failed" });
    }
    return true;
  }

  // ── GET /api/auth/me ────────────────────────────────────────────────────
  if (pathname === "/api/auth/me" && req.method === "GET") {
    try {
      const authCtx = requireAuth(req);
      const user = await getUserById(authCtx.userId);
      if (!user) {
        return sendJson(res, 404, { error: "User not found" }), true;
      }
      sendJson(res, 200, {
        id: user.id,
        tenantId: user.tenant_id,
        displayName: user.display_name,
        email: user.email,
        role: user.role,
        lastLoginAt: user.last_login_at,
        createdAt: user.created_at,
      });
    } catch (err) {
      sendJson(res, err.statusCode || 500, { error: err.message });
    }
    return true;
  }

  // ── PUT /api/auth/me ────────────────────────────────────────────────────
  if (pathname === "/api/auth/me" && req.method === "PUT") {
    try {
      const authCtx = requireAuth(req);
      const body = await parseBody(req);
      const updates = {};

      if (body.displayName) {
        if (body.displayName.trim().length < 2) {
          return sendJson(res, 400, { error: "Display name must be at least 2 characters" }), true;
        }
        updates.displayName = body.displayName;
      }

      if (body.currentPassword && body.newPassword) {
        const user = await getUserById(authCtx.userId);
        // getUserById doesn't return password_hash, so fetch it
        const fullUser = await getUserByEmail(authCtx.email);
        const match = await verifyPassword(body.currentPassword, fullUser.password_hash);
        if (!match) {
          return sendJson(res, 400, { error: "Current password is incorrect" }), true;
        }
        const pwError = validatePasswordStrength(body.newPassword);
        if (pwError) {
          return sendJson(res, 400, { error: pwError }), true;
        }
        updates.passwordHash = await hashPassword(body.newPassword);
      }

      if (Object.keys(updates).length > 0) {
        await updateUserProfile(authCtx.userId, updates);
      }

      sendJson(res, 200, { success: true, message: "Profile updated" });
    } catch (err) {
      sendJson(res, err.statusCode || 500, { error: err.message });
    }
    return true;
  }

  // ── GET /api/auth/invitation — get invitation details ───────────────────
  if (pathname === "/api/auth/invitation" && req.method === "GET") {
    try {
      const token = url.searchParams.get("token");
      if (!token) {
        return sendJson(res, 400, { error: "Token is required" }), true;
      }
      const invitation = await getInvitation(token);
      if (!invitation) {
        return sendJson(res, 400, { error: "Invalid or expired invitation" }), true;
      }
      sendJson(res, 200, {
        email: invitation.email,
        role: invitation.role,
        expiresAt: invitation.expires_at,
      });
    } catch (err) {
      sendJson(res, 500, { error: "Failed to load invitation" });
    }
    return true;
  }

  return false; // Not handled
}
