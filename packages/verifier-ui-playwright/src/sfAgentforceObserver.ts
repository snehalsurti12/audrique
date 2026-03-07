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
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    // Try role-based tab first
    const tab = page
      .getByRole("tab", { name: /agentforce/i })
      .first();
    if ((await tab.count()) > 0 && (await tab.isVisible().catch(() => false))) {
      const selected = (
        (await tab.getAttribute("aria-selected").catch(() => "")) ?? ""
      ).toLowerCase();
      if (selected === "true") {
        return;
      }
      await tab.click({ force: true }).catch(() => undefined);
      await page.waitForTimeout(600);
      const selectedAfter = (
        (await tab.getAttribute("aria-selected").catch(() => "")) ?? ""
      ).toLowerCase();
      if (selectedAfter === "true") {
        return;
      }
    }

    // Fallback: any clickable element with text "Agentforce"
    const fallback = page
      .locator("a, button, li, div[role='tab'], div[role='button']")
      .filter({ hasText: /agentforce/i })
      .first();
    if (
      (await fallback.count()) > 0 &&
      (await fallback.isVisible().catch(() => false))
    ) {
      await fallback.click({ force: true }).catch(() => undefined);
      await page.waitForTimeout(600);
      // Verify we're on the right tab by checking for KPI cards or table
      const snap = await readAgentforceActiveCount(page);
      if (snap.source !== "none") {
        return;
      }
    }

    await page.waitForTimeout(500);
  }
  console.warn(
    "[agentforce-observer] Could not find/click Agentforce tab after 20s — continuing anyway."
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

  // Navigate to Command Center for Service app
  const appCandidates = [
    args.supervisorAppName || "Command Center for Service",
    "Command Center for Service",
    args.appName,
  ].filter((name) => name.trim().length > 0);
  try {
    await ensureAnySalesforceApp(page, appCandidates);
  } catch {
    await dismissPresenceAppSwitchBanner(page);
  }

  await page.waitForTimeout(2000);

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
    await page.waitForTimeout(3000);
  }

  console.warn(
    `[agentforce-observer] Timeout after ${timeoutMs}ms. Last snapshot: ${lastSnapshot.signature}`
  );
  return lastSnapshot;
}
