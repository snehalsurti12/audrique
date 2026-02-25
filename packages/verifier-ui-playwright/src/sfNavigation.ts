/**
 * sfNavigation.ts — Salesforce Lightning app navigation, login assertion,
 * and App Launcher interaction.
 *
 * Extracted from salesforce-voice.spec.ts (Phase A, Step 1).
 */

import type { Page } from "@playwright/test";

// ── Utility ──────────────────────────────────────────────────────────────────

export function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ── URL / start-target resolution ────────────────────────────────────────────

export function resolveSalesforceStartTarget(input: {
  serviceConsoleUrl: string;
  appUrl: string;
  baseUrl: string;
}): string | null {
  const direct = input.appUrl.trim();
  if (direct) {
    if (/^https?:\/\//i.test(direct)) {
      return direct;
    }
    if (/^https?:\/\//i.test(input.baseUrl)) {
      return new URL(direct, input.baseUrl).toString();
    }
    throw new Error("SF_APP_URL is relative. Set SF_INSTANCE_URL or use absolute SF_APP_URL.");
  }

  const consoleUrl = input.serviceConsoleUrl.trim();
  if (consoleUrl) {
    if (/^https?:\/\//i.test(consoleUrl)) {
      return consoleUrl;
    }
    if (/^https?:\/\//i.test(input.baseUrl)) {
      return new URL(consoleUrl, input.baseUrl).toString();
    }
    throw new Error(
      "SF_SERVICE_CONSOLE_URL is relative. Set SF_INSTANCE_URL, or omit it and use SF_APP_NAME."
    );
  }

  if (/^https?:\/\//i.test(input.baseUrl)) {
    return new URL("/lightning/page/home", input.baseUrl).toString();
  }
  return null;
}

// ── Page navigation with Lightning redirect tolerance ────────────────────────

export async function gotoWithLightningRedirectTolerance(page: Page, targetUrl: string): Promise<void> {
  try {
    await page.goto(targetUrl, { waitUntil: "domcontentloaded" });
    return;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/interrupted by another navigation/i.test(message)) {
      throw error;
    }
    await page.waitForLoadState("domcontentloaded").catch(() => undefined);
    await page.waitForTimeout(500);
    // If redirected into Lightning shell (one.app), continue.
    if (/\/one\/one\.app/i.test(page.url())) {
      return;
    }
    // Retry once for transient redirect races.
    await page.goto(targetUrl, { waitUntil: "domcontentloaded" });
  }
}

// ── Login assertions ─────────────────────────────────────────────────────────

export async function assertLoginSucceeded(page: Page): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const url = page.url();
    const title = await page.title().catch(() => "");
    const needsIdentityVerification =
      url.includes("/_ui/identity/verification/") || /verify your identity/i.test(title);
    if (needsIdentityVerification) {
      throw new Error(
        `Salesforce requires interactive identity verification for this session. URL=${url}`
      );
    }

    const usernameFieldVisible = await page
      .getByLabel("Username")
      .isVisible()
      .catch(() => false);
    const passwordFieldVisible = await page
      .getByLabel("Password")
      .isVisible()
      .catch(() => false);
    const stillOnLoginHost = /:\/\/test\.salesforce\.com(\/|$)/i.test(url);
    if (!usernameFieldVisible && !passwordFieldVisible && !stillOnLoginHost) {
      return;
    }
    await page.waitForTimeout(500);
  }

  const errorText = (
    await page
      .locator("#error, .loginError, .message.errorM3, .oneError")
      .allTextContents()
      .catch(() => [])
  )
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" | ");
  const suffix = errorText ? ` Error=${errorText}` : "";
  throw new Error(`Salesforce login did not complete. URL=${page.url()}${suffix}`);
}

export async function assertAuthenticatedConsolePage(page: Page): Promise<void> {
  const finishLoginVisible = await page
    .getByRole("link", { name: /finish logging in/i })
    .isVisible()
    .catch(() => false);
  if (finishLoginVisible) {
    throw new Error(
      `Salesforce login flow is incomplete for this session (Finish Logging In). URL=${page.url()}`
    );
  }

  const usernameFieldVisible = await page
    .getByLabel("Username")
    .isVisible()
    .catch(() => false);
  const loginButtonVisible = await page
    .getByRole("button", { name: /log in/i })
    .isVisible()
    .catch(() => false);

  if (!usernameFieldVisible && !loginButtonVisible) {
    return;
  }

  throw new Error(`Session is not authenticated on Service Console URL. URL=${page.url()}`);
}

// ── App detection & switching ────────────────────────────────────────────────

export async function isInSalesforceApp(page: Page, appName: string): Promise<boolean> {
  const appRegex = new RegExp(escapeRegex(appName), "i");
  const heading = page.getByRole("heading", { name: appRegex }).first();
  if ((await heading.count()) > 0) {
    return true;
  }
  const text = await page.locator("body").innerText().catch(() => "");
  return appRegex.test(text);
}

export async function waitForSalesforceApp(page: Page, appName: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isInSalesforceApp(page, appName)) {
      return true;
    }
    await page.waitForTimeout(400);
  }
  return false;
}

export async function closeAppLauncherIfOpen(page: Page): Promise<void> {
  const launcher = page
    .locator("section,div[role='dialog'],div")
    .filter({ hasText: /app launcher/i })
    .first();
  if ((await launcher.count()) === 0 || !(await launcher.isVisible().catch(() => false))) {
    return;
  }

  const closeButton = launcher
    .locator("button[title*='close' i], button[aria-label*='close' i]")
    .first();
  if ((await closeButton.count()) > 0 && (await closeButton.isVisible().catch(() => false))) {
    await closeButton.click({ force: true }).catch(() => undefined);
    await page.waitForTimeout(150);
  } else {
    await page.keyboard.press("Escape").catch(() => undefined);
    await page.waitForTimeout(150);
  }
}

export async function ensureSalesforceApp(page: Page, appName: string): Promise<void> {
  if (await waitForSalesforceApp(page, appName, 5000)) {
    return;
  }

  const directAppUrl = process.env.SF_APP_URL?.trim();
  if (directAppUrl) {
    await page.goto(directAppUrl, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1200);
    if (await waitForSalesforceApp(page, appName, 7000)) {
      return;
    }
  }

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
    const appResult = page.getByRole("link", { name: appRegex }).first();
    if ((await appResult.count()) > 0) {
      await Promise.all([page.waitForLoadState("domcontentloaded"), appResult.click({ force: true })]);
      await page.waitForTimeout(1200);
    } else {
      const appResultButton = page.getByRole("button", { name: appRegex }).first();
      if ((await appResultButton.count()) > 0) {
        await Promise.all([
          page.waitForLoadState("domcontentloaded"),
          appResultButton.click({ force: true })
        ]);
        await page.waitForTimeout(1200);
      }
    }
  }

  if (await waitForSalesforceApp(page, appName, 7000)) {
    return;
  }

  await closeAppLauncherIfOpen(page).catch(() => undefined);

  throw new Error(`Not in "${appName}" app context. URL=${page.url()}`);
}

export async function ensureAnySalesforceApp(page: Page, appNames: string[]): Promise<string> {
  const seen = new Set<string>();
  const candidates = appNames
    .map((name) => name.trim())
    .filter((name) => name.length > 0)
    .filter((name) => {
      const key = name.toLowerCase();
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
  let lastError: unknown = null;
  for (const name of candidates) {
    try {
      await ensureSalesforceApp(page, name);
      return name;
    } catch (error) {
      lastError = error;
      await closeAppLauncherIfOpen(page).catch(() => undefined);
    }
  }
  if (lastError instanceof Error) {
    throw lastError;
  }
  throw new Error(`Failed to switch to any Salesforce app from: ${candidates.join(", ")}`);
}
