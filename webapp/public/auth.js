/**
 * Client-side auth module — shared between login page and Studio SPA.
 *
 * - Access token stored in sessionStorage (survives page reloads, cleared on tab close)
 * - Refresh token stored as httpOnly cookie (managed by server, invisible to JS)
 * - Auto-refresh on 401 responses with retry
 * - Role-based UI: hides write controls for viewers
 */

/* global fetch, sessionStorage, window, document */

const auth = {
  accessToken: sessionStorage.getItem("audrique_access_token") || null,
  user: JSON.parse(sessionStorage.getItem("audrique_user") || "null"),

  isAuthenticated() {
    return !!this.accessToken && !!this.user;
  },

  /**
   * Attempt to restore session from refresh token cookie.
   * Called on page load — if successful, populates accessToken + user.
   */
  async tryRestore() {
    if (this.isAuthenticated()) return true;
    return this.refresh();
  },

  /**
   * Refresh the access token using the httpOnly cookie.
   */
  async refresh() {
    try {
      const res = await fetch("/api/auth/refresh", {
        method: "POST",
        credentials: "include",
      });
      if (res.ok) {
        const data = await res.json();
        this.accessToken = data.accessToken;
        this.user = data.user;
        sessionStorage.setItem("audrique_access_token", data.accessToken);
        sessionStorage.setItem("audrique_user", JSON.stringify(data.user));
        return true;
      }
    } catch {}
    return false;
  },

  /**
   * Enhanced fetch that adds Bearer token and auto-refreshes on 401.
   * Drop-in replacement for the Studio's `api()` function.
   */
  async apiFetch(endpoint, opts = {}) {
    if (!opts.headers) opts.headers = {};
    if (this.accessToken) {
      opts.headers["Authorization"] = `Bearer ${this.accessToken}`;
    }
    if (!opts.headers["Content-Type"]) {
      opts.headers["Content-Type"] = "application/json";
    }

    let res = await fetch(`/api${endpoint}`, opts);

    // On 401, try refresh and retry once
    if (res.status === 401 && !opts._retried) {
      const refreshed = await this.refresh();
      if (refreshed) {
        opts._retried = true;
        opts.headers["Authorization"] = `Bearer ${this.accessToken}`;
        res = await fetch(`/api${endpoint}`, opts);
      } else {
        // Refresh failed — redirect to login
        this.clearSession();
        window.location.href = "/login.html";
        return { error: "Session expired" };
      }
    }

    return res.json();
  },

  /**
   * Log out — revoke refresh token and redirect.
   */
  async logout() {
    try {
      await fetch("/api/auth/logout", { method: "POST", credentials: "include" });
    } catch {}
    this.clearSession();
    window.location.href = "/login.html";
  },

  clearSession() {
    this.accessToken = null;
    this.user = null;
    sessionStorage.removeItem("audrique_access_token");
    sessionStorage.removeItem("audrique_user");
  },

  /**
   * Apply role-based UI visibility.
   * Call after auth bootstrap — hides write controls for viewers.
   */
  applyRoleUI() {
    if (!this.user) return;
    const role = this.user.role;

    // Viewer: hide all builder and admin elements, show viewer-only, make wizard read-only
    if (role === "viewer") {
      document.querySelectorAll(".role-builder, .role-admin").forEach(
        (el) => (el.style.display = "none")
      );
      document.querySelectorAll(".role-viewer-only").forEach(
        (el) => (el.style.display = "")
      );
      document.body.classList.add("viewer-readonly");
    }
    // Builder: hide admin-only elements
    if (role === "builder") {
      document.querySelectorAll(".role-admin").forEach(
        (el) => (el.style.display = "none")
      );
    }
  },
};
