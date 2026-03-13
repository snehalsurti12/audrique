/**
 * Auth middleware — JWT extraction and role enforcement.
 *
 * Works with the existing pure HTTP router pattern in server.mjs:
 *   const authCtx = requireAuth(req);   // throws 401
 *   requireRole(authCtx, "builder");    // throws 403
 */

import { verifyAccessToken } from "./jwt.mjs";

const ROLE_HIERARCHY = { viewer: 0, builder: 1, admin: 2 };

/**
 * Extract and verify auth from a request.
 * Reads the Authorization: Bearer <token> header.
 *
 * @param {import('http').IncomingMessage} req
 * @returns {{ userId: string, tenantId: string, role: string, email: string }}
 * @throws {AuthError} with statusCode 401
 */
export function requireAuth(req) {
  let token;

  const authHeader = req.headers["authorization"];
  if (authHeader && authHeader.startsWith("Bearer ")) {
    token = authHeader.slice(7);
  } else {
    // Fallback: query param token (needed for EventSource which can't set headers)
    const url = new URL(req.url, "http://localhost");
    const qToken = url.searchParams.get("token");
    if (qToken) {
      token = qToken;
    }
  }

  if (!token) {
    const err = new Error("Authentication required");
    err.statusCode = 401;
    throw err;
  }
  try {
    const payload = verifyAccessToken(token);
    return {
      userId: payload.sub,
      tenantId: payload.tid,
      role: payload.role,
      email: payload.email,
    };
  } catch (e) {
    const err = new Error(e.message === "Token expired" ? "Token expired" : "Invalid token");
    err.statusCode = 401;
    throw err;
  }
}

/**
 * Enforce minimum role level.
 * Hierarchy: admin > builder > viewer.
 *
 * @param {{ role: string }} authContext - from requireAuth()
 * @param {string} minRole - minimum required role
 * @throws {Error} with statusCode 403
 */
export function requireRole(authContext, minRole) {
  const userLevel = ROLE_HIERARCHY[authContext.role] ?? -1;
  const requiredLevel = ROLE_HIERARCHY[minRole] ?? 0;

  if (userLevel < requiredLevel) {
    const err = new Error("Insufficient permissions");
    err.statusCode = 403;
    throw err;
  }
}
