/**
 * Salesforce Connected App OAuth Authentication
 *
 * API-based auth flow (no password sharing required):
 *   1. Build OAuth authorize URL → user logs in on Salesforce's domain
 *   2. Exchange authorization code for access_token + refresh_token
 *   3. Navigate Playwright to frontdoor.jsp?sid={access_token}
 *   4. Browser gets SF session cookies → save as storageState
 *
 * Mirrors the Connect CCP federation pattern in capture-connect-session.mjs.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const DEFAULT_SCOPES = "id api web refresh_token";
const TOKEN_LIFETIME_SEC = 7200; // 2 hours (typical SF access token lifetime)

// ── PKCE ────────────────────────────────────────────────────────────────────

export function generatePkce() {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  return { codeVerifier: verifier, codeChallenge: challenge };
}

// ── Authorize URL ───────────────────────────────────────────────────────────

/**
 * Build the Salesforce OAuth authorization URL with PKCE.
 * @param {object} opts
 * @param {string} opts.consumerKey   - Connected App Consumer Key
 * @param {string} opts.callbackUrl   - Redirect URI registered in the Connected App
 * @param {string} opts.loginUrl      - e.g. https://login.salesforce.com or https://test.salesforce.com
 * @param {string} [opts.state]       - Opaque state value (e.g., profileId)
 * @param {string} [opts.scopes]      - Space-separated scopes
 * @param {string} [opts.codeChallenge] - PKCE code challenge
 * @returns {string} Full authorize URL
 */
export function buildAuthorizeUrl({ consumerKey, callbackUrl, loginUrl, state, scopes, codeChallenge }) {
  const base = loginUrl.replace(/\/+$/, "");
  const params = new URLSearchParams({
    response_type: "code",
    client_id: consumerKey,
    redirect_uri: callbackUrl,
    scope: scopes || DEFAULT_SCOPES,
  });
  if (codeChallenge) {
    params.set("code_challenge", codeChallenge);
    params.set("code_challenge_method", "S256");
  }
  if (state) params.set("state", state);
  return `${base}/services/oauth2/authorize?${params.toString()}`;
}

// ── Token Exchange ──────────────────────────────────────────────────────────

/**
 * Exchange an authorization code for access + refresh tokens.
 * @param {object} opts
 * @param {string} opts.code
 * @param {string} opts.consumerKey
 * @param {string} opts.consumerSecret
 * @param {string} opts.callbackUrl
 * @param {string} opts.loginUrl
 * @returns {Promise<object>} { access_token, refresh_token, instance_url, issued_at, scope, id }
 */
export async function exchangeCodeForTokens({ code, consumerKey, consumerSecret, callbackUrl, loginUrl, codeVerifier }) {
  const base = loginUrl.replace(/\/+$/, "");
  const body = {
    grant_type: "authorization_code",
    code,
    client_id: consumerKey,
    redirect_uri: callbackUrl,
  };
  // External Client Apps use PKCE (public client) — client_secret is optional
  if (consumerSecret) body.client_secret = consumerSecret;
  if (codeVerifier) body.code_verifier = codeVerifier;
  const resp = await fetch(`${base}/services/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  });

  const data = await resp.json();
  if (!resp.ok || data.error) {
    throw new Error(`Token exchange failed: ${data.error_description || data.error || resp.statusText}`);
  }
  return data;
}

// ── Token Refresh ───────────────────────────────────────────────────────────

/**
 * Refresh an expired access token using the refresh token.
 * @param {object} opts
 * @param {string} opts.refreshToken
 * @param {string} opts.consumerKey
 * @param {string} opts.consumerSecret
 * @param {string} opts.loginUrl
 * @returns {Promise<object>} { access_token, instance_url, issued_at, scope, id }
 */
export async function refreshAccessToken({ refreshToken, consumerKey, consumerSecret, loginUrl }) {
  const base = loginUrl.replace(/\/+$/, "");
  const body = {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: consumerKey,
  };
  // PKCE public clients don't require client_secret for refresh
  if (consumerSecret) body.client_secret = consumerSecret;
  const resp = await fetch(`${base}/services/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  });

  const data = await resp.json();
  if (!resp.ok || data.error) {
    throw new Error(`Token refresh failed: ${data.error_description || data.error || resp.statusText}`);
  }
  return data;
}

// ── frontdoor.jsp Session Creation ──────────────────────────────────────────

/**
 * Create an authenticated Salesforce browser session via frontdoor.jsp.
 *
 * Flow:
 *   1. Launch headless Playwright browser
 *   2. Navigate to {instanceUrl}/secur/frontdoor.jsp?sid={accessToken}
 *   3. SF sets session cookies (sid, etc.)
 *   4. Navigate to the target app (e.g., Service Console)
 *   5. Save storageState (identical format to password-based login)
 *
 * @param {object} opts
 * @param {string} opts.accessToken     - OAuth access token
 * @param {string} opts.instanceUrl     - e.g. https://your-org.lightning.force.com
 * @param {string} opts.storageStatePath - e.g. .auth/sf-personal.json
 * @param {string} [opts.appName]       - App to navigate to (default: "Service Console")
 * @param {string} [opts.appUrl]        - Direct URL to the app (optional)
 * @returns {Promise<{authenticated: boolean, finalUrl: string, storageStatePath: string}>}
 */
export async function createSessionViaFrontdoor(opts) {
  const { chromium } = await import("playwright");

  const appName = opts.appName || "Service Console";
  const storageStatePath = opts.storageStatePath || ".auth/sf-agent.json";
  const cookiesPath = opts.cookiesPath || ".auth/sf-cookies.json";

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  try {
    // Step 1: Navigate to frontdoor.jsp — creates SF session
    const frontdoorUrl = `${opts.instanceUrl}/secur/frontdoor.jsp?sid=${opts.accessToken}`;
    console.log(`[sf-oauth] Navigating to frontdoor.jsp...`);
    await page.goto(frontdoorUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForTimeout(2000);

    // Step 2: Verify we're not stuck on login page
    const currentUrl = page.url();
    const stillOnLogin = currentUrl.includes("/login") ||
      currentUrl.includes("frontdoor.jsp") ||
      (await page.getByLabel("Username").isVisible().catch(() => false));

    if (stillOnLogin) {
      console.error(`[sf-oauth] frontdoor.jsp did not create session. Current URL: ${currentUrl}`);
      await page.screenshot({ path: "test-results/sf-oauth-frontdoor-fail.png", fullPage: true }).catch(() => {});
      await browser.close();
      return { authenticated: false, finalUrl: currentUrl, storageStatePath };
    }

    // Step 3: Navigate to target app
    const targetUrl = opts.appUrl || `${opts.instanceUrl}/lightning/page/home`;
    console.log(`[sf-oauth] Navigating to app: ${targetUrl}`);
    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForTimeout(1500);

    // Step 4: Ensure we're in the right app (reuse logic from sf-login-probe)
    await ensureSalesforceApp(page, appName);

    // Step 5: Final authentication check
    const finalStillOnLogin = await page.getByLabel("Username").isVisible().catch(() => false);
    const authenticated = !finalStillOnLogin;

    // Step 6: Save storageState (identical format to password-based login)
    fs.mkdirSync(path.dirname(path.resolve(process.cwd(), storageStatePath)), { recursive: true });
    await page.context().storageState({ path: storageStatePath });
    const cookies = await page.context().cookies();
    fs.writeFileSync(cookiesPath, JSON.stringify(cookies, null, 2), "utf8");
    await page.screenshot({ path: "test-results/sf-oauth-session.png", fullPage: true }).catch(() => {});

    console.log(`[sf-oauth] Session ${authenticated ? "created" : "FAILED"}. URL: ${page.url()}`);
    await browser.close();

    return { authenticated, finalUrl: page.url(), storageStatePath, cookiesPath };
  } catch (err) {
    await page.screenshot({ path: "test-results/sf-oauth-error.png", fullPage: true }).catch(() => {});
    await browser.close();
    throw err;
  }
}

// ── Token Storage ───────────────────────────────────────────────────────────

/**
 * Save OAuth tokens to disk.
 * @param {string} profileId
 * @param {object} tokens - { access_token, refresh_token, instance_url, issued_at, scope }
 */
export function saveOAuthTokens(profileId, tokens) {
  const filePath = oauthTokenPath(profileId);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(tokens, null, 2), "utf8");
}

/**
 * Load OAuth tokens from disk.
 * @param {string} profileId
 * @returns {object|null}
 */
export function loadOAuthTokens(profileId) {
  const filePath = oauthTokenPath(profileId);
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Check if an access token is expired.
 * @param {object} tokens
 * @returns {boolean}
 */
export function isTokenExpired(tokens) {
  if (!tokens?.issued_at) return true;
  const issuedMs = typeof tokens.issued_at === "string"
    ? parseInt(tokens.issued_at, 10)
    : tokens.issued_at;
  return Date.now() > issuedMs + TOKEN_LIFETIME_SEC * 1000;
}

function oauthTokenPath(profileId) {
  return path.resolve(process.cwd(), `.auth/sf-oauth-${profileId || "default"}.json`);
}

// ── App Navigation (reused from sf-login-probe.mjs) ─────────────────────────

async function ensureSalesforceApp(page, appName) {
  if (await isInSalesforceApp(page, appName)) return;

  const appLauncher = page
    .getByRole("button", { name: /app launcher/i })
    .or(page.getByText(/app launcher/i))
    .first();

  if ((await appLauncher.count()) > 0) {
    await appLauncher.click({ force: true });
    await page.waitForTimeout(600);
    const search = page
      .getByRole("searchbox", { name: /search apps|search apps and items/i })
      .or(page.getByPlaceholder(/search apps|search apps and items/i))
      .first();
    if ((await search.count()) > 0) {
      await search.fill(appName);
      await page.waitForTimeout(600);
    }
    const appRegex = new RegExp(escapeRegex(appName), "i");
    const appResult = page
      .getByRole("link", { name: appRegex })
      .or(page.getByRole("button", { name: appRegex }))
      .first();
    if ((await appResult.count()) > 0) {
      await Promise.all([page.waitForLoadState("domcontentloaded"), appResult.click({ force: true })]);
      await page.waitForTimeout(1200);
    }
  }
}

async function isInSalesforceApp(page, appName) {
  const appRegex = new RegExp(escapeRegex(appName), "i");
  const heading = page.getByRole("heading", { name: appRegex }).first();
  if ((await heading.count()) > 0) return true;
  const text = await page.locator("body").innerText().catch(() => "");
  return appRegex.test(text);
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ── Full OAuth Auth Flow (called from sf-login-probe.mjs) ───────────────────

/**
 * Attempt OAuth-based SF authentication.
 * Used as the fast path in sf-login-probe.mjs when OAuth is configured.
 *
 * @param {object} opts
 * @param {string} opts.consumerKey
 * @param {string} opts.consumerSecret
 * @param {string} opts.loginUrl
 * @param {string} opts.storageStatePath
 * @param {string} [opts.appName]
 * @param {string} [opts.profileId]
 * @returns {Promise<{success: boolean, error?: string}>}
 */
export async function tryOAuthRefreshAuth(opts) {
  const profileId = opts.profileId || "default";
  const tokens = loadOAuthTokens(profileId);

  if (!tokens?.refresh_token) {
    return {
      success: false,
      error: "No OAuth tokens found. Complete the OAuth flow in Scenario Studio first.",
    };
  }

  try {
    // Refresh the access token
    let accessToken = tokens.access_token;
    let instanceUrl = tokens.instance_url;

    if (isTokenExpired(tokens)) {
      console.log("[sf-oauth] Access token expired, refreshing...");
      const refreshed = await refreshAccessToken({
        refreshToken: tokens.refresh_token,
        consumerKey: opts.consumerKey,
        consumerSecret: opts.consumerSecret,
        loginUrl: opts.loginUrl,
      });
      accessToken = refreshed.access_token;
      instanceUrl = refreshed.instance_url || instanceUrl;

      // Save updated tokens (keep the refresh_token since SF doesn't always return a new one)
      saveOAuthTokens(profileId, {
        ...tokens,
        access_token: accessToken,
        instance_url: instanceUrl,
        issued_at: refreshed.issued_at || String(Date.now()),
      });
      console.log("[sf-oauth] Token refreshed successfully.");
    } else {
      console.log("[sf-oauth] Access token still valid.");
    }

    // Create browser session via frontdoor.jsp
    const result = await createSessionViaFrontdoor({
      accessToken,
      instanceUrl,
      storageStatePath: opts.storageStatePath,
      appName: opts.appName,
    });

    if (!result.authenticated) {
      return { success: false, error: "frontdoor.jsp session creation failed" };
    }

    console.log(JSON.stringify({
      authenticated: true,
      method: "oauth",
      finalUrl: result.finalUrl,
      storageStatePath: result.storageStatePath,
      cookiesPath: result.cookiesPath,
    }, null, 2));

    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}
