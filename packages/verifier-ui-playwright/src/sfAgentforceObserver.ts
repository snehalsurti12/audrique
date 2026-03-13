/**
 * sfAgentforceObserver.ts — Command Center → Agentforce tab observation.
 *
 * Opens the Agentforce tab inside Command Center for Service, reads KPI
 * summary cards (All Agentforce Agents / Agentforce Service Agent), and
 * polls until a target active-conversation count is reached.
 *
 * Follows patterns from sfSupervisorObserver.ts (same-context tabs,
 * DOM evaluation via page.evaluate, deadline-based polling).
 */

import type { BrowserContext, Page } from "@playwright/test";
import {
  gotoWithLightningRedirectTolerance,
  assertAuthenticatedConsolePage,
  ensureAnySalesforceApp,
  closeAppLauncherIfOpen,
} from "./sfNavigation";
import { dismissPresenceAppSwitchBanner } from "./sfOmniChannel";

// ── Types ────────────────────────────────────────────────────────────────────

export type AgentforceSnapshot = {
  totalActive: number;
  serviceAgentActive: number;
  tableRowCount: number;
  source: string; // "kpi_card" | "table" | "none"
  signature: string;
};

export type AgentforceObserverSession = {
  page: Page;
  baselineSnapshot: AgentforceSnapshot;
  observation: Promise<AgentforceSnapshot>;
  videoPath?: string;
  end: () => Promise<void>;
};

// ── Tab navigation ───────────────────────────────────────────────────────────

/**
 * Click the "Agentforce" tab inside Command Center for Service.
 * Follows the same pattern as ensureSupervisorServiceRepsSurfaceOpen.
 */
export async function ensureAgentforceTabOpen(page: Page): Promise<void> {
  // Salesforce LWC uses closed shadow roots — page.evaluate() DOM traversal returns null
  // for el.shadowRoot on closed roots. Use Playwright's CDP-based locators (getByText,
  // getByRole) which pierce all shadow roots regardless of open/closed mode.

  // Try clicking a visible element whose text matches the pattern.
  // Iterates all matches so we can skip excluded ones (e.g. Service Console "More" button).
  async function playwrightClick(
    textPattern: RegExp,
    excludeAriaLabel?: RegExp
  ): Promise<boolean> {
    const matches = page.getByText(textPattern);
    const count = await matches.count().catch(() => 0);
    for (let i = 0; i < count; i++) {
      const el = matches.nth(i);
      const ariaLabel = (await el.getAttribute("aria-label").catch(() => "")) ?? "";
      if (excludeAriaLabel && excludeAriaLabel.test(ariaLabel)) continue;
      await el.click({ force: true }).catch(() => undefined);
      return true;
    }
    return false;
  }

  // Log what text nodes are present near the sub-navigation for diagnostics
  const navTexts = await page.evaluate(() => {
    const all = Array.from(document.querySelectorAll("*"));
    return all
      .map((el) => (el as HTMLElement).innerText?.trim())
      .filter((t) => t && t.length < 40 && /agentforce|in.progress|more/i.test(t))
      .slice(0, 20);
  }).catch(() => [] as string[]);
  console.log(`[agentforce-observer] Sub-nav text nodes found: ${JSON.stringify(navTexts)}`);

  const deadline = Date.now() + 30_000;
  let attempt = 0;
  while (Date.now() < deadline) {
    attempt++;

    // Step 1: Check if Agentforce is directly visible (already expanded or as a tab)
    const agentforceVisible = await page.getByText(/agentforce/i).first().isVisible().catch(() => false);
    if (agentforceVisible) {
      const clicked = await playwrightClick(/^agentforce$/i);
      if (clicked) {
        console.log(`[agentforce-observer] Clicked Agentforce tab (attempt ${attempt})`);
        await page.waitForTimeout(800);
        return;
      }
    }

    // Step 2: Click "More" to expand hidden nav items.
    // The Command Center sub-nav "More ▼" button text starts with "More".
    // Exclude the Service Console tab-bar "More" (aria-label="Show additional tabs").
    const moreVisible = await page.getByText(/^more/i).first().isVisible().catch(() => false);
    if (moreVisible) {
      const clicked = await playwrightClick(/^more/i, /additional tabs/i);
      if (clicked) {
        console.log(`[agentforce-observer] Clicked 'More' dropdown (attempt ${attempt})`);
        await page.waitForTimeout(800);
        continue; // next iteration will find Agentforce in the open dropdown
      }
    }

    // Diagnostic: log what getByText finds on each failed attempt (first 3 only)
    if (attempt <= 3) {
      const moreCount = await page.getByText(/^more/i).count().catch(() => 0);
      const afCount = await page.getByText(/agentforce/i).count().catch(() => 0);
      console.log(`[agentforce-observer] Attempt ${attempt}: getByText('More') count=${moreCount}, getByText('Agentforce') count=${afCount}`);
    }

    await page.waitForTimeout(500);
  }
  console.warn(
    "[agentforce-observer] Could not find/click Agentforce tab after 30s — continuing anyway."
  );
}

// ── KPI / table reading ──────────────────────────────────────────────────────

/**
 * Read the Agentforce active count from the Command Center's Agentforce tab.
 * Tries KPI summary cards first, then falls back to counting table rows.
 */
export async function readAgentforceActiveCount(
  page: Page
): Promise<AgentforceSnapshot> {
  return page.evaluate(() => {
    const norm = (s: string) => s.replace(/\s+/g, " ").trim();
    const asInt = (s: string) => {
      const m = s.replace(/,/g, "").match(/-?\d+/);
      return m ? parseInt(m[0], 10) : NaN;
    };

    let totalActive = NaN;
    let serviceAgentActive = NaN;
    let source = "none";

    // Strategy 1: KPI summary cards
    // Look for text like "All Agentforce Agents\n0" or "Agentforce Service Agent\n0"
    const allTextNodes = document.body.innerText || "";
    const allAgentsMatch = allTextNodes.match(
      /all\s+agentforce\s+agents?\s*[:\-]?\s*(\d+)/i
    );
    const serviceAgentMatch = allTextNodes.match(
      /agentforce\s+service\s+agents?\s*[:\-]?\s*(\d+)/i
    );
    if (allAgentsMatch) {
      totalActive = parseInt(allAgentsMatch[1], 10);
      source = "kpi_card";
    }
    if (serviceAgentMatch) {
      serviceAgentActive = parseInt(serviceAgentMatch[1], 10);
      if (source === "none") source = "kpi_card";
    }

    // Strategy 2: KPI via card-like elements (p, span, div with large text)
    if (isNaN(totalActive)) {
      const cards = Array.from(
        document.querySelectorAll(
          ".slds-card, .slds-box, [class*='kpi'], [class*='metric'], [class*='summary']"
        )
      );
      for (const card of cards) {
        const text = norm((card as HTMLElement).innerText || "");
        if (/all\s+agentforce/i.test(text)) {
          const val = asInt(text.replace(/.*all\s+agentforce\s+agents?\s*/i, ""));
          if (!isNaN(val)) {
            totalActive = val;
            source = "kpi_card";
          }
        }
        if (/agentforce\s+service/i.test(text)) {
          const val = asInt(
            text.replace(/.*agentforce\s+service\s+agents?\s*/i, "")
          );
          if (!isNaN(val)) {
            serviceAgentActive = val;
            if (source === "none") source = "kpi_card";
          }
        }
      }
    }

    // Strategy 3: Count table rows as fallback
    let tableRowCount = 0;
    const tables = Array.from(document.querySelectorAll("table"));
    for (const table of tables) {
      const rows = Array.from(table.querySelectorAll("tbody tr")).filter(
        (row) => {
          const text = norm((row as HTMLElement).innerText || "");
          return (
            text.length > 0 &&
            !/no records|no data|no items/i.test(text) &&
            !/sort\s+by:/i.test(text.slice(0, 30))
          );
        }
      );
      if (rows.length > tableRowCount) {
        tableRowCount = rows.length;
      }
    }

    // If KPI cards didn't yield totalActive, use table row count
    if (isNaN(totalActive) && tableRowCount > 0) {
      totalActive = tableRowCount;
      source = "table";
    }

    const safeTotalActive = isNaN(totalActive) ? 0 : totalActive;
    const safeServiceActive = isNaN(serviceAgentActive)
      ? 0
      : serviceAgentActive;

    return {
      totalActive: safeTotalActive,
      serviceAgentActive: safeServiceActive,
      tableRowCount,
      source,
      signature: `total=${safeTotalActive},service=${safeServiceActive},rows=${tableRowCount}`,
    };
  });
}

// ── Observer session ─────────────────────────────────────────────────────────

/**
 * Start the Agentforce observer: opens Command Center for Service in a new
 * tab (same BrowserContext as the agent page), navigates to the Agentforce
 * tab, and starts polling for the expected active count.
 */
export async function startAgentforceObserver(args: {
  agentPage: Page;
  targetUrl: string;
  appName: string;
  supervisorAppName: string;
  expectedCount: number;
  timeoutMs: number;
}): Promise<AgentforceObserverSession> {
  // Open a new tab in the SAME browser context (avoids session conflicts)
  const context = args.agentPage.context();
  const page = await context.newPage();

  await gotoWithLightningRedirectTolerance(page, args.targetUrl);
  await assertAuthenticatedConsolePage(page);

  // Navigate to Command Center for Service app.
  // Only try supervisor-specific app names — never fall back to the agent app (e.g. Service Console)
  // since that app does not have the Agentforce tab and would silently produce a false success.
  const appCandidates = [
    args.supervisorAppName || "Command Center for Service",
    "Command Center for Service",
  ].filter((name, i, arr) => name.trim().length > 0 && arr.indexOf(name) === i);

  let navigatedToSupervisorApp = false;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await ensureAnySalesforceApp(page, appCandidates);
      navigatedToSupervisorApp = true;
      console.log(`[agentforce-observer] Navigated to supervisor app (attempt ${attempt}). URL=${page.url()}`);
      break;
    } catch (err) {
      console.warn(`[agentforce-observer] Navigation attempt ${attempt}/3 failed: ${err instanceof Error ? err.message : err}`);
      if (attempt < 3) {
        await page.waitForTimeout(2000);
      }
    }
  }

  if (!navigatedToSupervisorApp) {
    console.error(`[agentforce-observer] Could not open Command Center for Service after 3 attempts. Current URL=${page.url()} — Agentforce tab search aborted.`);
    await page
      .screenshot({ path: "test-results/agentforce-observer-nav-failed.png", fullPage: false })
      .catch(() => undefined);
    await dismissPresenceAppSwitchBanner(page);
    // Fall through with best-effort — page may already be in Command Center from a prior nav
  }

  await page.waitForTimeout(2000);

  // Confirm we're on the right page before looking for the Agentforce tab
  await page
    .screenshot({ path: "test-results/agentforce-observer-before-tab.png", fullPage: false })
    .catch(() => undefined);
  console.log(`[agentforce-observer] Page before tab search: URL=${page.url()} title="${await page.title().catch(() => "")}"`);

  // Click the Agentforce tab
  await ensureAgentforceTabOpen(page);
  await page.waitForTimeout(2000);

  // Capture baseline
  const baselineSnapshot = await readAgentforceActiveCount(page);
  console.log(
    `[agentforce-observer] Baseline: ${baselineSnapshot.signature}`
  );

  // Start polling observation
  const observation = waitForAgentforceCount(
    page,
    args.expectedCount,
    args.timeoutMs
  );

  let videoPath: string | undefined;

  const end = async () => {
    await page
      .screenshot({
        path: "test-results/agentforce-observer-final.png",
        fullPage: false,
      })
      .catch(() => undefined);
    // Capture video path before closing (Playwright finalizes on close)
    try {
      videoPath = await page.video()?.path();
    } catch {
      // Video may not be available in all configurations
    }
    await page.close().catch(() => undefined);
  };

  const session: AgentforceObserverSession = {
    page,
    baselineSnapshot,
    observation,
    get videoPath() {
      return videoPath;
    },
    end,
  };
  return session;
}

// ── Polling ──────────────────────────────────────────────────────────────────

/**
 * Poll readAgentforceActiveCount until totalActive >= expectedCount or timeout.
 */
export async function waitForAgentforceCount(
  page: Page,
  expectedCount: number,
  timeoutMs: number
): Promise<AgentforceSnapshot> {
  const deadline = Date.now() + timeoutMs;
  let lastSnapshot: AgentforceSnapshot = {
    totalActive: 0,
    serviceAgentActive: 0,
    tableRowCount: 0,
    source: "none",
    signature: "not_read",
  };

  while (Date.now() < deadline) {
    try {
      lastSnapshot = await readAgentforceActiveCount(page);
      console.log(
        `[agentforce-observer] Poll: ${lastSnapshot.signature} (want >= ${expectedCount})`
      );
      if (lastSnapshot.totalActive >= expectedCount) {
        console.log(
          `[agentforce-observer] Target reached: ${lastSnapshot.totalActive} >= ${expectedCount}`
        );
        // Take evidence screenshot
        await page
          .screenshot({
            path: "test-results/agentforce-count-reached.png",
            fullPage: false,
          })
          .catch(() => undefined);
        return lastSnapshot;
      }
    } catch (err) {
      console.warn(
        `[agentforce-observer] Poll error: ${err}`
      );
    }
    try {
      await page.waitForTimeout(3000);
    } catch {
      // Page closed or test ended — stop polling gracefully
      break;
    }
  }

  console.warn(
    `[agentforce-observer] Timeout after ${timeoutMs}ms. Last snapshot: ${lastSnapshot.signature}`
  );
  return lastSnapshot;
}
