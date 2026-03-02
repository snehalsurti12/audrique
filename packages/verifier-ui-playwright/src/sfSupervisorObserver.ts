/**
 * sfSupervisorObserver.ts — Supervisor console: queue/agent observation,
 * Command Center navigation, table DOM parsing, and overlay rendering.
 *
 * Extracted from salesforce-voice.spec.ts (Phase A, Step 1).
 */

import type { BrowserContext, Page } from "@playwright/test";
import fs from "node:fs";
import {
  escapeRegex,
  gotoWithLightningRedirectTolerance,
  assertAuthenticatedConsolePage,
  ensureAnySalesforceApp,
  closeAppLauncherIfOpen,
} from "./sfNavigation";
import { dismissPresenceAppSwitchBanner } from "./sfOmniChannel";

// ── Types ────────────────────────────────────────────────────────────────────

export type SupervisorQueueObservation = {
  queueName: string;
  metric: "queue_waiting" | "in_progress_work";
  observedCount: number;
  waitingCount: number;
  source: string;
  observedAtMs: number;
};

export type SupervisorQueueObserverSession = {
  context: BrowserContext;
  page: Page;
  inProgressPage?: Page;
  queueName: string;
  baselineWaitingCount: number;
  baselineInProgressCount: number;
  baselineInProgressSignature: string;
  observation: Promise<SupervisorQueueObservation>;
  videoPath?: string;
  end: () => Promise<void>;
};

export type SupervisorAgentOfferObservation = {
  agentName: string;
  source: string;
  details: string;
  observedAtMs: number;
};

export type SupervisorAgentObserverSession = {
  context: BrowserContext;
  page: Page;
  agentName: string;
  baselineSignature: string;
  observation: Promise<SupervisorAgentOfferObservation>;
  videoPath?: string;
  end: () => Promise<void>;
};

// ── Queue observer session ───────────────────────────────────────────────────

export async function startSupervisorQueueObserver(args: {
  agentPage: Page;
  targetUrl: string;
  appName: string;
  supervisorAppName: string;
  supervisorSurfaceName: string;
  queueName: string;
  timeoutMs: number;
  videoDir: string;
}): Promise<SupervisorQueueObserverSession> {
  // Open supervisor as a new tab (page) in the SAME browser context as the agent.
  // Using a separate context causes Salesforce to show "You have logged in from
  // another location" and disconnects the agent's CTI/Phone utility.
  const context = args.agentPage.context();
  const page = await context.newPage();
  await gotoWithLightningRedirectTolerance(page, args.targetUrl);
  await assertAuthenticatedConsolePage(page);
  let resolvedApp = args.appName;
  // Build app candidates: prioritize the supervisor surface name (e.g. "Command
  // Center for Service") as an app target BEFORE falling back to "Service Console".
  // The previous approach tried "Service Console" first and succeeded immediately
  // (page was already there) — but stayed on the Home page without supervisor views.
  const fallbackSurfaces = (process.env.SUPERVISOR_FALLBACK_SURFACES?.trim() || "")
    .split(",").map(s => s.trim()).filter(Boolean);
  const appCandidates = [
    args.supervisorSurfaceName,
    args.supervisorAppName,
    ...fallbackSurfaces,
    args.appName
  ].filter((name) => name.trim().length > 0);
  try {
    resolvedApp = await ensureAnySalesforceApp(page, appCandidates);
  } catch {
    // Same-context tabs may fail to switch apps when agent presence is "Available for Voice".
    // Dismiss the error banner and continue — the supervisor surface may still be accessible.
    await dismissPresenceAppSwitchBanner(page);
  }
  const skipQueueBacklog = /^(true|1|yes|on)$/i.test(
    (process.env.SUPERVISOR_SKIP_QUEUE_BACKLOG ?? "false").trim()
  );
  const allowInProgressFallback = !/^(false|0|no|off)$/i.test(
    (process.env.SUPERVISOR_ALLOW_IN_PROGRESS_FALLBACK ?? "false").trim()
  );
  // When the in-progress fallback is enabled, don't let surface discovery
  // failure abort the supervisor — the in-progress work table may still be
  // reachable even when the full Command Center / Omni Supervisor app is
  // inaccessible (common in same-context multi-tab setups).
  if (allowInProgressFallback) {
    await ensureOmniSupervisorSurfaceOpen(page, args.queueName, args.supervisorSurfaceName).catch(() => undefined);
  } else {
    await ensureOmniSupervisorSurfaceOpen(page, args.queueName, args.supervisorSurfaceName);
  }
  if (!skipQueueBacklog) {
    await ensureSupervisorQueuesBacklogSurfaceOpen(page, args.queueName).catch(() => undefined);
  }

  const baseline = skipQueueBacklog
    ? 0
    : await readSupervisorQueueWaitingCount(page, args.queueName).catch(() => 0);
  let baselineInProgressCount = 0;
  let baselineInProgressSignature = "";
  let inProgressPage: Page | undefined;

  if (allowInProgressFallback || skipQueueBacklog) {
    // Two-tab mode: open a dedicated page for In-Progress Work monitoring.
    // This avoids surface-switching on one page (which was throttled to 10s
    // to protect the CTI adapter). Each tab stays on its surface permanently.
    inProgressPage = await context.newPage();
    await gotoWithLightningRedirectTolerance(inProgressPage, args.targetUrl);
    await assertAuthenticatedConsolePage(inProgressPage);
    try {
      await ensureAnySalesforceApp(inProgressPage, appCandidates);
    } catch {
      await dismissPresenceAppSwitchBanner(inProgressPage);
    }
    await ensureOmniSupervisorSurfaceOpen(inProgressPage, args.queueName, args.supervisorSurfaceName).catch(() => undefined);
    await ensureSupervisorInProgressWorkSurfaceOpen(inProgressPage);
    const inProgressBaseline = await readSupervisorInProgressWorkSnapshot(inProgressPage, args.queueName);
    baselineInProgressCount = inProgressBaseline.inProgressCount;
    baselineInProgressSignature = inProgressBaseline.signature;
  }

  await renderSupervisorMonitorOverlay(
    page,
    `Supervisor monitor active${args.queueName ? ` (${args.queueName})` : ""}`,
    `app=${resolvedApp} | baseline waiting=${baseline} | baseline in-progress=${baselineInProgressCount} | tabs=${inProgressPage ? 2 : 1}`
  );

  const observation = waitForSupervisorQueueWaiting(page, {
    queueName: args.queueName,
    timeoutMs: args.timeoutMs,
    baselineWaitingCount: baseline,
    baselineInProgressCount,
    baselineInProgressSignature,
    inProgressPage,
  });
  observation.catch(() => undefined);

  const session: SupervisorQueueObserverSession = {
    context,
    page,
    inProgressPage,
    queueName: args.queueName,
    baselineWaitingCount: baseline,
    baselineInProgressCount,
    baselineInProgressSignature,
    observation,
    videoPath: undefined,
    end: async () => {
      const video = page.video();
      // Close supervisor pages, not the shared context (agent still needs it).
      if (inProgressPage) {
        await inProgressPage.close().catch(() => undefined);
      }
      await page.close();
      if (video) {
        const vPath = await video.path().catch(() => undefined);
        if (vPath) {
          await new Promise((r) => setTimeout(r, 500));
          if (fs.existsSync(vPath) && fs.statSync(vPath).size > 0) {
            session.videoPath = vPath;
          }
        }
      }
    }
  };
  return session;
}

// ── Agent observer session ───────────────────────────────────────────────────

export async function startSupervisorAgentObserver(args: {
  agentPage: Page;
  targetUrl: string;
  appName: string;
  supervisorAppName: string;
  supervisorSurfaceName: string;
  agentName: string;
  timeoutMs: number;
  videoDir: string;
}): Promise<SupervisorAgentObserverSession> {
  // Open supervisor agent monitor as a new tab in the SAME browser context.
  const context = args.agentPage.context();
  const page = await context.newPage();
  await gotoWithLightningRedirectTolerance(page, args.targetUrl);
  await assertAuthenticatedConsolePage(page);
  let resolvedApp = args.appName;
  const fallbackSurfaces = (process.env.SUPERVISOR_FALLBACK_SURFACES?.trim() || "")
    .split(",").map(s => s.trim()).filter(Boolean);
  const appCandidates = [
    args.supervisorSurfaceName,
    args.supervisorAppName,
    ...fallbackSurfaces,
    args.appName
  ].filter((name) => name.trim().length > 0);
  try {
    resolvedApp = await ensureAnySalesforceApp(page, appCandidates);
  } catch {
    await dismissPresenceAppSwitchBanner(page);
  }
  await ensureOmniSupervisorSurfaceOpen(page, "", args.supervisorSurfaceName);
  await ensureSupervisorServiceRepsSurfaceOpen(page);

  const baseline = await readSupervisorAgentOfferSnapshot(page, args.agentName);
  await renderSupervisorMonitorOverlay(
    page,
    `Supervisor agent monitor active${args.agentName ? ` (${args.agentName})` : ""}`,
    `app=${resolvedApp} | baseline=${baseline.signature}`
  );

  const observation = waitForSupervisorAgentOffer(page, {
    agentName: args.agentName,
    timeoutMs: args.timeoutMs,
    baselineSignature: baseline.signature
  });
  observation.catch(() => undefined);

  const session: SupervisorAgentObserverSession = {
    context,
    page,
    agentName: args.agentName,
    baselineSignature: baseline.signature,
    observation,
    videoPath: undefined,
    end: async () => {
      const video = page.video();
      await page.close();
      if (video) {
        const vPath = await video.path().catch(() => undefined);
        if (vPath) {
          await new Promise((r) => setTimeout(r, 500));
          if (fs.existsSync(vPath) && fs.statSync(vPath).size > 0) {
            session.videoPath = vPath;
          }
        }
      }
    }
  };
  return session;
}

// ── Surface navigation ───────────────────────────────────────────────────────

export async function ensureOmniSupervisorSurfaceOpen(
  page: Page,
  queueName: string,
  surfaceName: string
): Promise<void> {
  const surfaceRegex = surfaceName.trim()
    ? new RegExp(escapeRegex(surfaceName.trim()), "i")
    : /command center for service|omni supervisor|supervisor/i;
  const explicitSurfaceTargets = [
    page.getByRole("tab", { name: surfaceRegex }).first(),
    page.getByRole("button", { name: surfaceRegex }).first(),
    page.locator("a,button,div[role='tab'],div[role='button']").filter({ hasText: surfaceRegex }).first()
  ];
  for (const target of explicitSurfaceTargets) {
    if ((await target.count()) === 0) {
      continue;
    }
    if (!(await target.isVisible().catch(() => false))) {
      continue;
    }
    await target.click({ force: true }).catch(() => undefined);
    await page.waitForTimeout(450);
    const discoveredNow = await discoverQueueBacklogSurface(page, queueName);
    if (discoveredNow.found) {
      return;
    }
    if (await isSurfaceTabSelected(page, surfaceRegex)) {
      return;
    }
  }

  const deadline = Date.now() + Math.max(15_000, Number(process.env.SUPERVISOR_SURFACE_WAIT_SEC ?? 30) * 1000);
  let lastSource = "none";
  let launcherAttempted = false;
  let urlNavigationAttempted = false;
  while (Date.now() < deadline) {
    const discovered = await discoverQueueBacklogSurface(page, queueName);
    if (discovered.found) {
      return;
    }
    if (await isSurfaceTabSelected(page, surfaceRegex)) {
      return;
    }
    lastSource = discovered.source;
    if (!launcherAttempted) {
      await openSupervisorSurfaceFromAppLauncher(page, surfaceName);
      launcherAttempted = true;
      const postLauncher = await discoverQueueBacklogSurface(page, queueName);
      if (postLauncher.found) {
        return;
      }
      if (await isSurfaceTabSelected(page, surfaceRegex)) {
        return;
      }
    }
    // Navigation Menu fallback: open the app's navigation menu and look for
    // Omni Supervisor or Command Center items. This finds navigation items
    // available in the current app without needing separate app permissions.
    if (!urlNavigationAttempted) {
      urlNavigationAttempted = true;
      const navMenuButton = page.getByRole("button", { name: /show navigation menu/i }).first();
      if ((await navMenuButton.count()) > 0 && (await navMenuButton.isVisible().catch(() => false))) {
        await navMenuButton.click({ force: true }).catch(() => undefined);
        await page.waitForTimeout(500);
        const navItemRegex = /omni.?supervisor|command center|queue/i;
        const navItems = [
          page.locator("[role='menuitem'], [role='option'], a").filter({ hasText: navItemRegex }).first(),
          page.locator("[role='menuitem'], [role='option'], a").filter({ hasText: surfaceRegex }).first()
        ];
        for (const item of navItems) {
          if ((await item.count()) > 0 && (await item.isVisible().catch(() => false))) {
            await item.click({ force: true }).catch(() => undefined);
            await page.waitForTimeout(2000);
            const postNav = await discoverQueueBacklogSurface(page, queueName);
            if (postNav.found || postNav.score >= 4) {
              return;
            }
            if (await isSurfaceTabSelected(page, surfaceRegex)) {
              return;
            }
            break;
          }
        }
        // Close the nav menu if it's still open and no item was found.
        await page.keyboard.press("Escape").catch(() => undefined);
        await page.waitForTimeout(200);
      }
      // URL-based fallback: try the standard Omni Supervisor navigation tab.
      const baseUrl = page.url().replace(/\/lightning\/.*$/i, "");
      const omniSupervisorUrl = `${baseUrl}/lightning/n/standard-OmniSupervisor`;
      await page.goto(omniSupervisorUrl, { waitUntil: "domcontentloaded", timeout: 15_000 }).catch(() => undefined);
      await page.waitForTimeout(2500);
      const postNav = await discoverQueueBacklogSurface(page, queueName);
      if (postNav.found || postNav.score >= 4) {
        return;
      }
      if (await isSurfaceTabSelected(page, surfaceRegex)) {
        return;
      }
    }
    await clickLikelyQueueBacklogControl(page, queueName, surfaceName);
    await page.waitForTimeout(350);
  }
  throw new Error(
    `Could not discover queue backlog/supervisor surface in Salesforce UI. Last source=${lastSource}`
  );
}

export async function openSupervisorSurfaceFromAppLauncher(page: Page, surfaceName: string): Promise<void> {
  const appLauncher = page.getByRole("button", { name: /app launcher/i }).first();
  if ((await appLauncher.count()) === 0 || !(await appLauncher.isVisible().catch(() => false))) {
    return;
  }

  await appLauncher.click({ force: true }).catch(() => undefined);
  await page.waitForTimeout(250);

  const search = page
    .getByRole("searchbox", { name: /search apps|search apps and items/i })
    .or(page.getByPlaceholder(/search apps|search apps and items/i))
    .first();
  if ((await search.count()) > 0 && (await search.isVisible().catch(() => false))) {
    const query = surfaceName.trim() || process.env.SUPERVISOR_DEFAULT_SEARCH_TERM?.trim() || "Supervisor";
    await search.fill(query).catch(() => undefined);
    await page.waitForTimeout(800);
  }

  const surfaceRegex = surfaceName.trim()
    ? new RegExp(escapeRegex(surfaceName.trim()), "i")
    : /command center for service|command center|queue backlog|supervisor/i;
  const resultCandidates = [
    page.getByRole("link", { name: surfaceRegex }).first(),
    page.getByRole("button", { name: surfaceRegex }).first(),
    page
      .locator("[role='option'], [role='menuitem'], a, button, span")
      .filter({ hasText: surfaceRegex })
      .first(),
    page
      .locator("[role='option'], [role='menuitem'], a, button, span")
      .filter({ hasText: /command center for service|command center|queue backlog|supervisor/i })
      .first()
  ];
  for (const candidate of resultCandidates) {
    if ((await candidate.count()) === 0) {
      continue;
    }
    if (!(await candidate.isVisible().catch(() => false))) {
      continue;
    }
    await candidate.click({ force: true }).catch(() => undefined);
    await page.waitForTimeout(450);
    await closeAppLauncherIfOpen(page).catch(() => undefined);
    return;
  }

  // Fallback: if the primary search didn't find the surface, try "Omni Supervisor".
  if (surfaceName.trim() && !/omni.?supervisor/i.test(surfaceName)) {
    if ((await search.count()) > 0 && (await search.isVisible().catch(() => false))) {
      await search.fill("Omni Supervisor").catch(() => undefined);
      await page.waitForTimeout(800);
      const fallbackCandidates = [
        page.getByRole("link", { name: /omni.?supervisor/i }).first(),
        page.getByRole("button", { name: /omni.?supervisor/i }).first(),
        page
          .locator("[role='option'], [role='menuitem'], a, button, span")
          .filter({ hasText: /omni.?supervisor/i })
          .first()
      ];
      for (const candidate of fallbackCandidates) {
        if ((await candidate.count()) === 0) {
          continue;
        }
        if (!(await candidate.isVisible().catch(() => false))) {
          continue;
        }
        await candidate.click({ force: true }).catch(() => undefined);
        await page.waitForTimeout(450);
        await closeAppLauncherIfOpen(page).catch(() => undefined);
        return;
      }
    }
  }

  await closeAppLauncherIfOpen(page).catch(() => undefined);
}

async function isSurfaceTabSelected(page: Page, surfaceRegex: RegExp): Promise<boolean> {
  const tab = page.getByRole("tab", { name: surfaceRegex }).first();
  if ((await tab.count()) === 0 || !(await tab.isVisible().catch(() => false))) {
    return false;
  }
  const selected = ((await tab.getAttribute("aria-selected").catch(() => "")) ?? "").toLowerCase();
  return selected === "true";
}

export async function ensureSupervisorServiceRepsSurfaceOpen(page: Page): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const tab = page.getByRole("tab", { name: /service reps|service representatives|agents/i }).first();
    if ((await tab.count()) > 0 && (await tab.isVisible().catch(() => false))) {
      const selected = ((await tab.getAttribute("aria-selected").catch(() => "")) ?? "").toLowerCase();
      if (selected === "true") {
        return;
      }
      await tab.click({ force: true }).catch(() => undefined);
      await page.waitForTimeout(300);
      const selectedAfter = ((await tab.getAttribute("aria-selected").catch(() => "")) ?? "").toLowerCase();
      if (selectedAfter === "true") {
        return;
      }
    }
    await clickLikelyServiceRepsControl(page).catch(() => undefined);
    await page.waitForTimeout(300);
  }
  throw new Error("Could not open Service Reps view in supervisor console.");
}

export async function ensureSupervisorQueuesBacklogSurfaceOpen(page: Page, queueName: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const tab = page.getByRole("tab", { name: /queues backlog/i }).first();
    if ((await tab.count()) > 0 && (await tab.isVisible().catch(() => false))) {
      const selected = ((await tab.getAttribute("aria-selected").catch(() => "")) ?? "").toLowerCase();
      if (selected === "true") {
        const tableReading = await readQueueWaitingFromTable(page, queueName);
        if (tableReading || !queueName) {
          return;
        }
      }
      await tab.click({ force: true }).catch(() => undefined);
      await page.waitForTimeout(300);
      const selectedAfter = ((await tab.getAttribute("aria-selected").catch(() => "")) ?? "").toLowerCase();
      if (selectedAfter === "true") {
        const tableReading = await readQueueWaitingFromTable(page, queueName);
        if (tableReading || !queueName) {
          return;
        }
      }
    }
    await clickLikelyQueueBacklogControl(page, queueName).catch(() => undefined);
    await page.waitForTimeout(300);
    const tableReading = await readQueueWaitingFromTable(page, queueName);
    if (tableReading) {
      return;
    }
  }
  throw new Error("Could not open Queues Backlog view in supervisor console.");
}

export async function ensureSupervisorInProgressWorkSurfaceOpen(page: Page): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const tab = page.getByRole("tab", { name: /in-?progress work/i }).first();
    if ((await tab.count()) > 0 && (await tab.isVisible().catch(() => false))) {
      const selected = ((await tab.getAttribute("aria-selected").catch(() => "")) ?? "").toLowerCase();
      if (selected === "true") {
        return;
      }
      await tab.click({ force: true }).catch(() => undefined);
      await page.waitForTimeout(300);
      const selectedAfter = ((await tab.getAttribute("aria-selected").catch(() => "")) ?? "").toLowerCase();
      if (selectedAfter === "true") {
        return;
      }
    }
    await clickLikelyInProgressWorkControl(page).catch(() => undefined);
    await page.waitForTimeout(300);
  }
  throw new Error("Could not open In-Progress Work view in supervisor console.");
}

// ── Observation polling ──────────────────────────────────────────────────────

/**
 * Dedicated poll loop for Queue Backlog surface on its own page.
 * No surface switching — polls at full speed.
 */
async function pollQueueBacklog(
  page: Page,
  args: {
    queueName: string;
    baselineWaitingCount: number;
    deadline: number;
    pollIntervalMs: number;
    navigateIntervalMs: number;
  }
): Promise<SupervisorQueueObservation> {
  const acceptAnyWaiting = /^(true|1|yes|on)$/i.test(
    (process.env.SUPERVISOR_ACCEPT_ANY_WAITING ?? "false").trim()
  );
  const requireTotalWaitingHeader = !/^(false|0|no|off)$/i.test(
    (process.env.SUPERVISOR_REQUIRE_TOTAL_WAITING_HEADER ?? "true").trim()
  );
  const requireTableSource = !/^(false|0|no|off)$/i.test(
    (process.env.SUPERVISOR_REQUIRE_TABLE_SOURCE ?? "true").trim()
  );
  let lastSource = "unknown";
  let lastNavigateAttemptMs = 0;

  while (Date.now() < args.deadline) {
    const snapshot = await readSupervisorQueueSnapshot(page, args.queueName);
    lastSource = snapshot.source;

    const sourceAllowed =
      !requireTableSource ||
      (snapshot.source.startsWith("table:") &&
        (!requireTotalWaitingHeader || /total\s*waiting/i.test(snapshot.source)));

    if (
      sourceAllowed &&
      (snapshot.waitingCount > Math.max(0, args.baselineWaitingCount) ||
        (acceptAnyWaiting && snapshot.waitingCount > 0))
    ) {
      const observed: SupervisorQueueObservation = {
        queueName: snapshot.queueName,
        metric: "queue_waiting",
        observedCount: snapshot.waitingCount,
        waitingCount: snapshot.waitingCount,
        source: snapshot.source,
        observedAtMs: Date.now()
      };
      await renderSupervisorMonitorOverlay(
        page,
        "Queue wait observed",
        `queue=${observed.queueName || "detected"}, waiting=${observed.observedCount}`
      );
      return observed;
    }

    if (
      lastSource === "table_missing" &&
      Date.now() - lastNavigateAttemptMs > args.navigateIntervalMs
    ) {
      await ensureSupervisorQueuesBacklogSurfaceOpen(page, args.queueName).catch(() => undefined);
      lastNavigateAttemptMs = Date.now();
    }

    await page.waitForTimeout(args.pollIntervalMs);
  }

  throw new Error(`pollQueueBacklog: no observation before deadline`);
}

/**
 * Dedicated poll loop for In-Progress Work surface on its own page.
 * No surface switching — polls at full speed (no 10s throttle needed).
 */
async function pollInProgressWork(
  page: Page,
  args: {
    queueName: string;
    baselineInProgressCount: number;
    baselineInProgressSignature: string;
    deadline: number;
    pollIntervalMs: number;
  }
): Promise<SupervisorQueueObservation> {
  const requireInProgressIncrease = !/^(false|0|no|off)$/i.test(
    (process.env.SUPERVISOR_IN_PROGRESS_REQUIRE_INCREASE ?? "true").trim()
  );
  const allowSignatureOnly = /^(true|1|yes|on)$/i.test(
    (process.env.SUPERVISOR_ALLOW_SIGNATURE_ONLY ?? "false").trim()
  );

  while (Date.now() < args.deadline) {
    const inProgressSnapshot = await readSupervisorInProgressWorkSnapshot(page, args.queueName);
    const inProgressCount = inProgressSnapshot.inProgressCount;
    const signatureChanged =
      Boolean(inProgressSnapshot.signature) &&
      Boolean(args.baselineInProgressSignature) &&
      inProgressSnapshot.signature !== args.baselineInProgressSignature;
    const inProgressIncreased = inProgressCount > Math.max(0, args.baselineInProgressCount);
    const inProgressPositive = inProgressCount > 0;
    const inProgressMatched = requireInProgressIncrease ? inProgressIncreased : inProgressPositive;

    if (inProgressMatched || (allowSignatureOnly && signatureChanged)) {
      const inProgressSource = inProgressMatched
        ? "in_progress_table"
        : "in_progress_signature_change";
      const observed: SupervisorQueueObservation = {
        queueName: inProgressSnapshot.queueName || args.queueName,
        metric: "in_progress_work",
        observedCount: inProgressCount,
        waitingCount: inProgressCount,
        source: inProgressSource,
        observedAtMs: Date.now()
      };
      await renderSupervisorMonitorOverlay(
        page,
        "In-progress work observed",
        `queue=${observed.queueName || "detected"}, in-progress=${observed.observedCount}, signature=${
          inProgressSnapshot.signature || "n/a"
        }`
      );
      return observed;
    }

    await page.waitForTimeout(args.pollIntervalMs);
  }

  throw new Error(`pollInProgressWork: no observation before deadline`);
}

export async function waitForSupervisorQueueWaiting(
  page: Page,
  args: {
    queueName: string;
    timeoutMs: number;
    baselineWaitingCount: number;
    baselineInProgressCount: number;
    baselineInProgressSignature: string;
    inProgressPage?: Page;
  }
): Promise<SupervisorQueueObservation> {
  const deadline = Date.now() + args.timeoutMs;
  const pollIntervalMs = Math.max(400, Number(process.env.SUPERVISOR_POLL_INTERVAL_MS ?? 1200));
  const navigateIntervalMs = Math.max(1500, Number(process.env.SUPERVISOR_NAVIGATION_INTERVAL_MS ?? 6000));
  const allowInProgressFallback = !/^(false|0|no|off)$/i.test(
    (process.env.SUPERVISOR_ALLOW_IN_PROGRESS_FALLBACK ?? "false").trim()
  );
  const skipQueueBacklog = /^(true|1|yes|on)$/i.test(
    (process.env.SUPERVISOR_SKIP_QUEUE_BACKLOG ?? "false").trim()
  );

  // Two-tab mode: dedicated pages for each surface, poll in parallel
  if (args.inProgressPage && (allowInProgressFallback || skipQueueBacklog)) {
    const polls: Promise<SupervisorQueueObservation>[] = [];

    if (!skipQueueBacklog) {
      polls.push(
        pollQueueBacklog(page, {
          queueName: args.queueName,
          baselineWaitingCount: args.baselineWaitingCount,
          deadline,
          pollIntervalMs,
          navigateIntervalMs,
        })
      );
    }

    polls.push(
      pollInProgressWork(args.inProgressPage, {
        queueName: args.queueName,
        baselineInProgressCount: args.baselineInProgressCount,
        baselineInProgressSignature: args.baselineInProgressSignature,
        deadline,
        pollIntervalMs,
      })
    );

    // Race: first surface to detect activity wins
    return Promise.race(polls);
  }

  // Single-page fallback (original behavior when no inProgressPage provided)
  let lastWaitingCount = args.baselineWaitingCount;
  let lastInProgressCount = args.baselineInProgressCount;
  let lastInProgressSignature = args.baselineInProgressSignature;
  let lastSource = "unknown";
  let lastNavigateAttemptMs = 0;
  let lastInProgressCheckMs = 0;
  // Throttle In-Progress surface switches to reduce disruption to the agent's
  // CTI adapter — navigating between supervisor surfaces in the same browser
  // context causes Salesforce to intermittently drop the telephony provider.
  const inProgressCheckIntervalMs = Math.max(
    5000,
    Number(process.env.SUPERVISOR_IN_PROGRESS_CHECK_INTERVAL_MS ?? 10000)
  );
  const acceptAnyWaiting = /^(true|1|yes|on)$/i.test(
    (process.env.SUPERVISOR_ACCEPT_ANY_WAITING ?? "false").trim()
  );
  const requireTotalWaitingHeader = !/^(false|0|no|off)$/i.test(
    (process.env.SUPERVISOR_REQUIRE_TOTAL_WAITING_HEADER ?? "true").trim()
  );
  const requireInProgressIncrease = !/^(false|0|no|off)$/i.test(
    (process.env.SUPERVISOR_IN_PROGRESS_REQUIRE_INCREASE ?? "true").trim()
  );
  const allowSignatureOnly = /^(true|1|yes|on)$/i.test(
    (process.env.SUPERVISOR_ALLOW_SIGNATURE_ONLY ?? "false").trim()
  );

  while (Date.now() < deadline) {
    if (!skipQueueBacklog) {
      const snapshot = await readSupervisorQueueSnapshot(page, args.queueName);
      lastWaitingCount = snapshot.waitingCount;
      lastSource = snapshot.source;

      const requireTableSource = !/^(false|0|no|off)$/i.test(
        (process.env.SUPERVISOR_REQUIRE_TABLE_SOURCE ?? "true").trim()
      );
      const sourceAllowed =
        !requireTableSource ||
        (snapshot.source.startsWith("table:") &&
          (!requireTotalWaitingHeader || /total\s*waiting/i.test(snapshot.source)));

      if (
        sourceAllowed &&
        (snapshot.waitingCount > Math.max(0, args.baselineWaitingCount) ||
          (acceptAnyWaiting && snapshot.waitingCount > 0))
      ) {
        const observed: SupervisorQueueObservation = {
          queueName: snapshot.queueName,
          metric: "queue_waiting",
          observedCount: snapshot.waitingCount,
          waitingCount: snapshot.waitingCount,
          source: snapshot.source,
          observedAtMs: Date.now()
        };
        await renderSupervisorMonitorOverlay(
          page,
          "Queue wait observed",
          `queue=${observed.queueName || "detected"}, waiting=${observed.observedCount}`
        );
        return observed;
      }
    }

    // Throttle In-Progress surface checks to avoid constant navigation that
    // disrupts the agent's CTI connection in the shared browser context.
    const shouldCheckInProgress =
      (allowInProgressFallback || skipQueueBacklog) &&
      (skipQueueBacklog || Date.now() - lastInProgressCheckMs >= inProgressCheckIntervalMs);
    if (shouldCheckInProgress) {
      lastInProgressCheckMs = Date.now();
      if (skipQueueBacklog) {
        await ensureSupervisorInProgressWorkSurfaceOpen(page);
      } else {
        await ensureSupervisorInProgressWorkSurfaceOpen(page).catch(() => undefined);
      }
      const inProgressSnapshot = await readSupervisorInProgressWorkSnapshot(page, args.queueName);
      const inProgressCount = inProgressSnapshot.inProgressCount;
      lastSource = inProgressSnapshot.signature ? "in_progress_table" : lastSource;
      lastInProgressCount = inProgressCount;
      lastInProgressSignature = inProgressSnapshot.signature;
      const signatureChanged =
        Boolean(inProgressSnapshot.signature) &&
        Boolean(args.baselineInProgressSignature) &&
        inProgressSnapshot.signature !== args.baselineInProgressSignature;
      const inProgressIncreased = inProgressCount > Math.max(0, args.baselineInProgressCount);
      const inProgressPositive = inProgressCount > 0;
      const inProgressMatched = requireInProgressIncrease ? inProgressIncreased : inProgressPositive;
      if (inProgressMatched || (allowSignatureOnly && signatureChanged)) {
        const inProgressSource = inProgressMatched
          ? "in_progress_table"
          : "in_progress_signature_change";
        const observed: SupervisorQueueObservation = {
          queueName: inProgressSnapshot.queueName || args.queueName,
          metric: "in_progress_work",
          observedCount: inProgressCount,
          waitingCount: inProgressCount,
          source: inProgressSource,
          observedAtMs: Date.now()
        };
        await renderSupervisorMonitorOverlay(
          page,
          "In-progress work observed",
          `queue=${observed.queueName || "detected"}, in-progress=${observed.observedCount}, signature=${
            inProgressSnapshot.signature || "n/a"
          }`
        );
        return observed;
      }
      if (!skipQueueBacklog) {
        await ensureSupervisorQueuesBacklogSurfaceOpen(page, args.queueName).catch(() => undefined);
      }
    }

    if (
      !skipQueueBacklog &&
      lastSource === "table_missing" &&
      Date.now() - lastNavigateAttemptMs > navigateIntervalMs
    ) {
      await ensureSupervisorQueuesBacklogSurfaceOpen(page, args.queueName).catch(() => undefined);
      lastNavigateAttemptMs = Date.now();
    }

    await page.waitForTimeout(pollIntervalMs);
  }

  throw new Error(
    `Supervisor queue waiting was not observed within ${Math.round(
      args.timeoutMs / 1000
    )}s. baselineWaiting=${args.baselineWaitingCount}, lastWaiting=${lastWaitingCount}, baselineInProgress=${
      args.baselineInProgressCount
    }, lastInProgress=${lastInProgressCount}, baselineInProgressSignature="${
      args.baselineInProgressSignature
    }", lastInProgressSignature="${lastInProgressSignature}", source=${lastSource}`
  );
}

export async function waitForSupervisorAgentOffer(
  page: Page,
  args: { agentName: string; timeoutMs: number; baselineSignature: string }
): Promise<SupervisorAgentOfferObservation> {
  const deadline = Date.now() + args.timeoutMs;
  const pollIntervalMs = Math.max(400, Number(process.env.SUPERVISOR_AGENT_POLL_INTERVAL_MS ?? 1200));
  const navigateIntervalMs = Math.max(
    1500,
    Number(process.env.SUPERVISOR_AGENT_NAVIGATION_INTERVAL_MS ?? 6000)
  );
  let lastSignature = args.baselineSignature;
  let lastDetails = "";
  let lastSource = "unknown";
  let lastNavigateAttemptMs = 0;
  while (Date.now() < deadline) {
    const snapshot = await readSupervisorAgentOfferSnapshot(page, args.agentName);
    lastSignature = snapshot.signature;
    lastDetails = snapshot.details;
    lastSource = snapshot.source;

    if (snapshot.offerDetected && snapshot.signature !== args.baselineSignature) {
      const observed: SupervisorAgentOfferObservation = {
        agentName: snapshot.agentName || args.agentName || "detected",
        source: snapshot.source,
        details: snapshot.details,
        observedAtMs: Date.now()
      };
      await renderSupervisorMonitorOverlay(
        page,
        "Agent offer observed",
        observed.details
      );
      return observed;
    }

    if (Date.now() - lastNavigateAttemptMs > navigateIntervalMs) {
      await clickLikelyServiceRepsControl(page).catch(() => undefined);
      lastNavigateAttemptMs = Date.now();
    }
    await page.waitForTimeout(pollIntervalMs);
  }
  throw new Error(
    `Supervisor agent offer was not observed within ${Math.round(
      args.timeoutMs / 1000
    )}s. baseline=${args.baselineSignature}, last=${lastSignature}, source=${lastSource}, details=${lastDetails}`
  );
}

// ── Reading snapshots ────────────────────────────────────────────────────────

export async function readSupervisorQueueWaitingCount(page: Page, queueName: string): Promise<number> {
  const snapshot = await readSupervisorQueueSnapshot(page, queueName);
  return snapshot.waitingCount;
}

export async function readSupervisorInProgressWorkSnapshot(
  page: Page,
  queueName: string
): Promise<{ queueName: string; inProgressCount: number; signature: string }> {
  const tableReading = await readInProgressWorkFromTable(page, queueName);
  if (tableReading) {
    return {
      queueName: tableReading.queueName,
      inProgressCount: tableReading.inProgressCount,
      signature: normalizeSignatureText(tableReading.signature)
    };
  }
  const requireTableSource = !/^(false|0|no|off)$/i.test(
    (process.env.SUPERVISOR_IN_PROGRESS_REQUIRE_TABLE ?? "true").trim()
  );
  if (requireTableSource) {
    return { queueName, inProgressCount: 0, signature: "" };
  }
  const bodyText = ((await page.locator("body").innerText().catch(() => "")) ?? "").replace(/\r/g, "");
  if (!/in-?progress work/i.test(bodyText)) {
    return { queueName, inProgressCount: 0, signature: "" };
  }
  return {
    queueName,
    inProgressCount: extractInProgressCount(bodyText),
    signature: normalizeSignatureText(bodyText.slice(0, 600))
  };
}

export async function readSupervisorQueueSnapshot(
  page: Page,
  queueName: string
): Promise<{ queueName: string; waitingCount: number; source: string }> {
  const tableReading = await readQueueWaitingFromTable(page, queueName);
  if (tableReading) {
    return {
      queueName: tableReading.queueName || queueName,
      waitingCount: tableReading.waitingCount,
      source: `table:${tableReading.waitingHeader || "waiting"}`
    };
  }

  // Avoid false positives from dashboard percentages (e.g. "100%") or unrelated
  // text blocks. In strict mode we only trust queue backlog table extraction.
  if (!/^(false|0|no|off)$/i.test((process.env.SUPERVISOR_REQUIRE_TABLE_SOURCE ?? "true").trim())) {
    return { queueName, waitingCount: 0, source: "table_missing" };
  }

  const surface = await discoverQueueBacklogSurface(page, queueName);
  if (surface.found && surface.text) {
    const waitingCount = extractQueueWaitingCount(surface.text);
    if (waitingCount > 0) {
      return {
        queueName: surface.queueName || queueName,
        waitingCount,
        source: `surface:${surface.source}`
      };
    }
  }

  const bodyText = ((await page.locator("body").innerText().catch(() => "")) ?? "").replace(/\r/g, "");
  if (!bodyText.trim()) {
    return { queueName, waitingCount: 0, source: "empty" };
  }

  const lines = bodyText
    .split(/\n+/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const queueRegex = queueName ? new RegExp(escapeRegex(queueName), "i") : null;

  if (queueRegex) {
    for (let i = 0; i < lines.length; i += 1) {
      if (!queueRegex.test(lines[i])) {
        continue;
      }
      const windowText = lines.slice(Math.max(0, i - 1), Math.min(lines.length, i + 7)).join(" ");
      const waitingCount = extractQueueWaitingCount(windowText);
      if (waitingCount > 0) {
        return { queueName, waitingCount, source: "queue_window" };
      }
    }
  }

  const globalWaiting = extractQueueWaitingCount(bodyText);
  return {
    queueName,
    waitingCount: globalWaiting,
    source: globalWaiting > 0 ? "global" : surface.source
  };
}

export async function readSupervisorAgentOfferSnapshot(
  page: Page,
  agentName: string
): Promise<{
  agentName: string;
  offerDetected: boolean;
  source: string;
  details: string;
  signature: string;
}> {
  const tableReading = await page.evaluate((targetAgent) => {
    const norm = (value: string) => value.replace(/\s+/g, " ").trim();
    // Strip SF Lightning interactive sort/filter text from header cells.
    const cleanHeader = (raw: string) => {
      const cleaned = raw
        .replace(/^sort\s+by:\s*/i, "")
        .replace(/\s*filter\s+for\s+column\s+.*/i, "")
        .trim();
      return cleaned || raw;
    };
    const asInt = (value: string) => {
      const m = value.replace(/,/g, "").match(/-?\d+/);
      if (!m) {
        return Number.NaN;
      }
      return Number.parseInt(m[0], 10);
    };
    const isOfferHeader = (header: string) => {
      const cleaned = cleanHeader(header);
      return /(offered|ringing|active work|active contacts|in progress|calls?|contacts?|voice|work)/i.test(cleaned) &&
        !/(capacity|utilization|occupancy|work size|priority)/i.test(cleaned);
    };

    const targetNeedle = (targetAgent || "").trim().toLowerCase();
    const tables = Array.from(document.querySelectorAll("table"));
    for (const table of tables) {
      const headerCells = Array.from(
        table.querySelectorAll("thead th, thead td, tr:first-child th, tr:first-child td")
      );
      const headers = headerCells.map((cell) => norm((cell as HTMLElement).innerText || cell.textContent || ""));
      if (headers.length === 0) {
        continue;
      }
      const offerIndexes = headers
        .map((h, i) => (isOfferHeader(h) ? i : -1))
        .filter((v) => v >= 0);
      if (offerIndexes.length === 0) {
        continue;
      }

      const rows = Array.from(table.querySelectorAll("tbody tr, tr")).filter((row) => {
        const text = norm((row as HTMLElement).innerText || row.textContent || "");
        return text.length > 0 &&
          !/service reps|offered|active work|in progress/i.test(text.slice(0, 60)) &&
          !/sort\s+by:/i.test(text.slice(0, 30));
      });
      for (const row of rows) {
        const cells = Array.from(row.querySelectorAll("th, td")).map((cell) =>
          norm((cell as HTMLElement).innerText || cell.textContent || "")
        );
        if (cells.length === 0) {
          continue;
        }
        const rowText = cells.join(" | ");
        const rowLower = rowText.toLowerCase();
        if (targetNeedle && !rowLower.includes(targetNeedle)) {
          continue;
        }
        const candidateAgent = cells[0] || targetAgent || "";
        const offerValues = offerIndexes
          .map((idx) => cells[idx] || "")
          .map((value) => asInt(value))
          .filter((value) => Number.isFinite(value)) as number[];
        const offerDetectedByValue = offerValues.some((value) => value > 0);
        const offerDetectedByText = /(ringing|offered|alerting|in call|talking|connected|busy|pending)/i.test(
          rowText
        );
        const offerDetected = offerDetectedByValue || offerDetectedByText;
        return {
          agentName: candidateAgent,
          offerDetected,
          source: "table",
          details: `agent=${candidateAgent}, values=${offerValues.join(",") || "n/a"}, row="${rowText.slice(
            0,
            220
          )}"`,
          signature: `${candidateAgent}|${offerValues.join(",")}|${offerDetectedByText ? "text" : "num"}`
        };
      }
    }
    return null;
  }, agentName);
  if (tableReading) {
    return tableReading;
  }

  const body = ((await page.locator("body").innerText().catch(() => "")) ?? "").replace(/\s+/g, " ").trim();
  const fallbackNeedle = agentName.trim();
  const hasNeedle = fallbackNeedle
    ? body.toLowerCase().includes(fallbackNeedle.toLowerCase())
    : /service reps/i.test(body);
  const offerDetected =
    hasNeedle && /(ringing|offered|alerting|in call|talking|connected|pending|missed)/i.test(body);
  const details = `agent=${fallbackNeedle || "auto"}, bodyPreview="${body.slice(0, 220)}"`;
  return {
    agentName: fallbackNeedle,
    offerDetected,
    source: "body",
    details,
    signature: `${fallbackNeedle}|${offerDetected ? "offer" : "no-offer"}|${body.slice(0, 120)}`
  };
}

// ── Table DOM parsing ────────────────────────────────────────────────────────

export async function readQueueWaitingFromTable(
  page: Page,
  queueName: string
): Promise<{ queueName: string; waitingCount: number; waitingHeader: string } | null> {
  return page.evaluate((targetQueue) => {
    const norm = (value: string) => value.replace(/\s+/g, " ").trim();
    // Strip SF Lightning interactive sort/filter text from header cells.
    // e.g. "Sort by: Queue Filter for column Queue" → "Queue"
    const cleanHeader = (raw: string) => {
      const cleaned = raw
        .replace(/^sort\s+by:\s*/i, "")
        .replace(/\s*filter\s+for\s+column\s+.*/i, "")
        .trim();
      return cleaned || raw;
    };
    const asInt = (value: string) => {
      const match = value.replace(/,/g, "").match(/-?\d+/);
      if (!match) {
        return Number.NaN;
      }
      return Number.parseInt(match[0], 10);
    };
    const isWaitingHeader = (header: string) => {
      const lower = cleanHeader(header).toLowerCase();
      if (/total\s*waiting/.test(lower)) {
        return true;
      }
      if (/wait\s*time|longest|average/.test(lower)) {
        return false;
      }
      return /^(waiting|contacts?\s+waiting)$/.test(lower);
    };

    const queueNeedle = (targetQueue || "").trim().toLowerCase();
    const tables = Array.from(document.querySelectorAll("table"));

    for (const table of tables) {
      const headerCells = Array.from(table.querySelectorAll("thead th, thead td, tr:first-child th, tr:first-child td"));
      const headers = headerCells.map((cell) => norm((cell as HTMLElement).innerText || cell.textContent || ""));
      if (headers.length === 0) {
        continue;
      }
      const queueIndex = headers.findIndex((header) => /queue|queues/i.test(cleanHeader(header).toLowerCase()));
      if (queueIndex < 0) {
        continue;
      }
      const waitingIndex = headers.findIndex((header) => isWaitingHeader(header));
      if (waitingIndex < 0) {
        continue;
      }

      const rows = Array.from(table.querySelectorAll("tbody tr, tr")).filter((row) => {
        const text = norm((row as HTMLElement).innerText || row.textContent || "");
        return text.length > 0 && !/total waiting/i.test(text) && !/sort\s+by:/i.test(text.slice(0, 30));
      });
      let best: { queueName: string; waitingCount: number; waitingHeader: string } | null = null;
      for (const row of rows) {
        const cells = Array.from(row.querySelectorAll("th, td")).map((cell) =>
          norm((cell as HTMLElement).innerText || cell.textContent || "")
        );
        if (cells.length === 0) {
          continue;
        }
        const rowQueue = cells[queueIndex] || cells[0] || "";
        if (queueNeedle && !rowQueue.toLowerCase().includes(queueNeedle)) {
          continue;
        }
        const waitingCell = cells[waitingIndex] || "";
        const waiting = asInt(waitingCell);
        if (!Number.isFinite(waiting)) {
          continue;
        }
        const candidate = {
          queueName: rowQueue,
          waitingCount: waiting,
          waitingHeader: headers[waitingIndex] || "waiting"
        };
        if (queueNeedle) {
          return candidate;
        }
        if (!best || candidate.waitingCount > best.waitingCount) {
          best = candidate;
        }
      }
      if (best) {
        return best;
      }
    }
    return null;
  }, queueName);
}

export async function readInProgressWorkFromTable(
  page: Page,
  queueName: string
): Promise<{ queueName: string; inProgressCount: number; signature: string } | null> {
  const allowRowFallback = /^(true|1|yes|on)$/i.test(
    (process.env.SUPERVISOR_IN_PROGRESS_ALLOW_ROW_MATCH ?? "false").trim()
  );
  return page.evaluate(({ targetQueue, allowRowFallbackIn }) => {
    const norm = (value: string) => value.replace(/\s+/g, " ").trim();
    // Strip SF Lightning interactive sort/filter text from header cells.
    const cleanHeader = (raw: string) => {
      const cleaned = raw
        .replace(/^sort\s+by:\s*/i, "")
        .replace(/\s*filter\s+for\s+column\s+.*/i, "")
        .trim();
      return cleaned || raw;
    };
    const asInt = (value: string) => {
      const match = value.replace(/,/g, "").match(/-?\d+/);
      if (!match) {
        return Number.NaN;
      }
      return Number.parseInt(match[0], 10);
    };
    const queueNeedle = (targetQueue || "").trim().toLowerCase();
    const selectedInProgressTab = Array.from(document.querySelectorAll("[role='tab'][aria-selected='true']")).find((tab) =>
      /in-?progress work/i.test(norm((tab as HTMLElement).innerText || tab.textContent || ""))
    ) as HTMLElement | undefined;

    const resolveScope = () => {
      if (!selectedInProgressTab) {
        return document;
      }
      const panelId = selectedInProgressTab.getAttribute("aria-controls");
      if (panelId) {
        const panel = document.getElementById(panelId);
        if (panel) {
          return panel;
        }
      }
      const fromTabList = selectedInProgressTab.closest("[role='tablist']")?.parentElement;
      return fromTabList || document;
    };

    const scope = resolveScope();
    const tables = Array.from(scope.querySelectorAll("table"));
    let bestOpenCount = Number.NEGATIVE_INFINITY;
    let bestOpenQueue = targetQueue || "";
    let bestOpenSignature = "";
    let foundOpenMetric = false;
    let bestCount = 0;
    let bestQueue = targetQueue || "";
    let bestSignature = "";

    for (const table of tables) {
      const headerCells = Array.from(
        table.querySelectorAll("thead th, thead td, tr:first-child th, tr:first-child td")
      );
      const headers = headerCells.map((cell) => norm((cell as HTMLElement).innerText || cell.textContent || ""));
      const queueIndex = headers.findIndex((header) => /\bqueue\b/i.test(cleanHeader(header).toLowerCase()));
      const openIndex = headers.findIndex((header) =>
        /\b(open|in-?progress|active)\b/i.test(cleanHeader(header).toLowerCase())
      );
      const assignedIndex = headers.findIndex((header) => /\bassigned\b/i.test(cleanHeader(header).toLowerCase()));
      const rows = Array.from(table.querySelectorAll("tbody tr")).filter((row) => {
        const text = norm((row as HTMLElement).innerText || row.textContent || "");
        return Boolean(text) && !/no records to display/i.test(text) && !/sort\s+by:/i.test(text.slice(0, 30));
      });
      if (rows.length === 0) {
        continue;
      }
      if (openIndex >= 0 || assignedIndex >= 0) {
        for (const row of rows) {
          const cells = Array.from(row.querySelectorAll("th, td")).map((cell) =>
            norm((cell as HTMLElement).innerText || cell.textContent || "")
          );
          if (cells.length === 0) {
            continue;
          }
          const rowQueue = queueIndex >= 0 ? cells[queueIndex] || targetQueue || "" : targetQueue || "";
          if (queueNeedle && queueIndex >= 0 && !rowQueue.toLowerCase().includes(queueNeedle)) {
            continue;
          }
          const openCount = openIndex >= 0 ? asInt(cells[openIndex] || "") : Number.NaN;
          const assignedCount = assignedIndex >= 0 ? asInt(cells[assignedIndex] || "") : Number.NaN;
          const hasOpen = Number.isFinite(openCount);
          const hasAssigned = Number.isFinite(assignedCount);
          if (!hasOpen && !hasAssigned) {
            continue;
          }
          const observedCount = Math.max(
            hasAssigned ? Math.max(0, assignedCount) : 0,
            hasOpen ? Math.max(0, openCount) : 0
          );
          foundOpenMetric = true;
          if (observedCount > bestOpenCount) {
            bestOpenCount = observedCount;
            bestOpenQueue = rowQueue;
            bestOpenSignature = `assigned=${
              hasAssigned ? assignedCount : "n/a"
            }|open=${hasOpen ? openCount : "n/a"}|row=${cells.join(" | ").slice(0, 220)}`;
          }
          if (queueNeedle) {
            break;
          }
        }
      }

      if (allowRowFallbackIn) {
        let matching = 0;
        const matchingRows: string[] = [];
        for (const row of rows) {
          const text = norm((row as HTMLElement).innerText || row.textContent || "");
          const lower = text.toLowerCase();
          if (queueNeedle && !lower.includes(queueNeedle)) {
            continue;
          }
          if (/voice|call|contact|phone|inbound|support queue|queue/i.test(lower)) {
            matching += 1;
            matchingRows.push(text.slice(0, 180));
          }
        }

        if (!queueNeedle) {
          matching = rows.length;
        }
        if (matching > bestCount) {
          bestCount = matching;
          bestSignature = matchingRows.slice(0, 5).join(" || ");
          if (!bestQueue && queueNeedle) {
            bestQueue = targetQueue;
          }
        }
      }
    }

    if (foundOpenMetric) {
      return {
        queueName: bestOpenQueue || targetQueue || "",
        inProgressCount: Number.isFinite(bestOpenCount) ? Math.max(0, bestOpenCount) : 0,
        signature: bestOpenSignature
      };
    }

    if (bestCount > 0) {
      return {
        queueName: bestQueue || targetQueue || "",
        inProgressCount: bestCount,
        signature: bestSignature
      };
    }

    return null;
  }, { targetQueue: queueName, allowRowFallbackIn: allowRowFallback });
}

// ── UI click helpers ─────────────────────────────────────────────────────────

export async function clickLikelyQueueBacklogControl(
  page: Page,
  queueName: string,
  surfaceName = ""
): Promise<void> {
  const queueSpecific = queueName ? new RegExp(escapeRegex(queueName), "i") : null;
  const surfaceSpecific = surfaceName ? new RegExp(escapeRegex(surfaceName), "i") : null;
  const genericSurfaceRegex =
    /command center|queues?\s*backlog|queue monitor|omni.?supervisor/i;
  const directCandidates = [
    page.getByRole("tab", { name: genericSurfaceRegex }).first(),
    page.getByRole("button", {
      name: genericSurfaceRegex
    }).first(),
    page
      .locator("a,button,div[role='tab'],div[role='button']")
      .filter({ hasText: genericSurfaceRegex })
      .first(),
    page
      .locator("a,button,div[role='tab'],div[role='button']")
      .filter({ hasText: /waiting|queued|in queue/i })
      .first()
  ];
  if (surfaceSpecific) {
    directCandidates.unshift(
      page.locator("a,button,div[role='tab'],div[role='button']").filter({ hasText: surfaceSpecific }).first()
    );
  }
  if (queueSpecific) {
    directCandidates.push(
      page.locator("a,button,div[role='tab'],div[role='button']").filter({ hasText: queueSpecific }).first()
    );
  }

  for (const candidate of directCandidates) {
    if ((await candidate.count()) === 0) {
      continue;
    }
    if (!(await candidate.isVisible().catch(() => false))) {
      continue;
    }
    await candidate.click({ force: true }).catch(() => undefined);
    await page.waitForTimeout(250);
    const discovered = await discoverQueueBacklogSurface(page, queueName);
    if (discovered.found) {
      return;
    }
  }

  const tabSwitcher = page.getByRole("combobox").first();
  if ((await tabSwitcher.count()) > 0 && (await tabSwitcher.isVisible().catch(() => false))) {
    await tabSwitcher.click({ force: true }).catch(() => undefined);
    await page.waitForTimeout(200);
    const supervisorOption = page
      .locator("[role='option'], [role='menuitem'], a, button")
      .filter({ hasText: /queues?\s*backlog|queue monitor|omni.?supervisor|command center/i })
      .first();
    if ((await supervisorOption.count()) > 0 && (await supervisorOption.isVisible().catch(() => false))) {
      await supervisorOption.click({ force: true }).catch(() => undefined);
      await page.waitForTimeout(250);
      const discovered = await discoverQueueBacklogSurface(page, queueName);
      if (discovered.found) {
        return;
      }
    }
  }

  const navMenuButton = page.getByRole("button", { name: /show navigation menu/i }).first();
  if ((await navMenuButton.count()) > 0 && (await navMenuButton.isVisible().catch(() => false))) {
    await navMenuButton.click({ force: true }).catch(() => undefined);
    await page.waitForTimeout(220);
    const navCandidateRegex = surfaceSpecific ?? genericSurfaceRegex;
    const navOptionCandidates = [
      page.getByRole("menuitem", { name: navCandidateRegex }).first(),
      page.getByRole("option", { name: navCandidateRegex }).first(),
      page
        .locator("[role='menuitem'], [role='option'], a, button, span")
        .filter({ hasText: navCandidateRegex })
        .first(),
      page
        .locator("[role='menuitem'], [role='option'], a, button, span")
        .filter({ hasText: /command center|queues?\s*backlog|omni.?supervisor/i })
        .first()
    ];
    for (const navOption of navOptionCandidates) {
      if ((await navOption.count()) === 0) {
        continue;
      }
      if (!(await navOption.isVisible().catch(() => false))) {
        continue;
      }
      await navOption.click({ force: true }).catch(() => undefined);
      await page.waitForTimeout(300);
      const discovered = await discoverQueueBacklogSurface(page, queueName);
      if (discovered.found) {
        return;
      }
    }
  }
}

export async function clickLikelyServiceRepsControl(page: Page): Promise<void> {
  const candidates = [
    page.getByRole("tab", { name: /service reps|service representatives|agents/i }).first(),
    page.getByRole("button", { name: /service reps|service representatives|agents/i }).first(),
    page
      .locator("a,button,div[role='tab'],div[role='button']")
      .filter({ hasText: /service reps|service representatives|agents/i })
      .first()
  ];
  for (const candidate of candidates) {
    if ((await candidate.count()) === 0) {
      continue;
    }
    if (!(await candidate.isVisible().catch(() => false))) {
      continue;
    }
    await candidate.click({ force: true }).catch(() => undefined);
    await page.waitForTimeout(250);
    return;
  }
}

export async function clickLikelyInProgressWorkControl(page: Page): Promise<void> {
  const candidates = [
    page.getByRole("tab", { name: /in-?progress work/i }).first(),
    page.getByRole("button", { name: /in-?progress work/i }).first(),
    page
      .locator("a,button,div[role='tab'],div[role='button']")
      .filter({ hasText: /in-?progress work/i })
      .first()
  ];
  for (const candidate of candidates) {
    if ((await candidate.count()) === 0) {
      continue;
    }
    if (!(await candidate.isVisible().catch(() => false))) {
      continue;
    }
    await candidate.click({ force: true }).catch(() => undefined);
    await page.waitForTimeout(250);
    return;
  }
}

// ── Surface discovery ────────────────────────────────────────────────────────

export async function discoverQueueBacklogSurface(
  page: Page,
  queueName: string
): Promise<{ found: boolean; source: string; text: string; queueName: string; score: number }> {
  return page.evaluate((targetQueue) => {
    const nodes = Array.from(
      document.querySelectorAll(
        "[role='region'], [role='tabpanel'], [role='complementary'], section, article, main, div"
      )
    );
    const queueNeedle = (targetQueue || "").trim().toLowerCase();
    let best = { found: false, source: "none", text: "", queueName: targetQueue || "", score: 0 };

    for (let i = 0; i < nodes.length; i += 1) {
      const node = nodes[i] as HTMLElement;
      const text = (node.innerText || "").replace(/\s+/g, " ").trim();
      if (!text || text.length < 24) {
        continue;
      }
      const rect = node.getBoundingClientRect();
      if (rect.width < 220 || rect.height < 80) {
        continue;
      }
      if (rect.bottom < 0 || rect.top > window.innerHeight) {
        continue;
      }

      const lower = text.toLowerCase();
      let score = 0;
      if (/queue|queues/.test(lower)) {
        score += 4;
      }
      if (/backlog|monitor|supervisor/.test(lower)) {
        score += 2;
      }
      if (/command center|queues backlog summary|total waiting|longest wait time|average wait time/.test(lower)) {
        score += 5;
      }
      if (/waiting|queued|in queue|contacts waiting/.test(lower)) {
        score += 5;
      }
      if (/(waiting|queued|in queue)\D{0,18}\d{1,4}/.test(lower)) {
        score += 6;
      }
      if (/\d{1,4}\D{0,18}(waiting|queued|in queue)/.test(lower)) {
        score += 6;
      }
      if (queueNeedle && lower.includes(queueNeedle)) {
        score += 7;
      }
      if (score <= 0) {
        continue;
      }

      if (score > best.score) {
        best = {
          found:
            score >= 8 ||
            /queues backlog summary|total waiting|longest wait time|average wait time/.test(lower),
          source: `region#${i}`,
          text: text.slice(0, 5000),
          queueName: queueNeedle && lower.includes(queueNeedle) ? targetQueue : "",
          score
        };
      }
    }

    return best;
  }, queueName);
}

// ── Text extraction helpers ──────────────────────────────────────────────────

export function extractQueueWaitingCount(text: string): number {
  let max = 0;
  const patterns = [
    /(?:contacts?\s+)?(?:waiting|queued|in\s+queue)\D{0,18}(\d{1,4})/gi,
    /(\d{1,4})\D{0,18}(?:contacts?\s+)?(?:waiting|queued|in\s+queue)/gi,
    /queue\D{0,18}(\d{1,4})\D{0,18}(?:waiting|queued|in\s+queue)/gi
  ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const count = Number.parseInt(match[1], 10);
      if (Number.isFinite(count) && count > max) {
        max = count;
      }
    }
  }
  return max;
}

export function extractInProgressCount(text: string): number {
  let max = 0;
  const patterns = [
    /(?:in-?progress(?: work)?|active work|active contacts?)\D{0,18}(\d{1,4})/gi,
    /(\d{1,4})\D{0,18}(?:in-?progress(?: work)?|active work|active contacts?)/gi
  ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const count = Number.parseInt(match[1], 10);
      if (Number.isFinite(count) && count > max) {
        max = count;
      }
    }
  }
  return max;
}

export function normalizeSignatureText(value: string): string {
  return value
    .replace(/\s+/g, " ")
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, "")
    .replace(/\b\d+\s?(?:s|sec|seconds|min|mins|minutes|h|hr|hours)\b/gi, "")
    .trim()
    .slice(0, 500);
}

// ── Overlay rendering ────────────────────────────────────────────────────────

export async function renderSupervisorMonitorOverlay(page: Page, title: string, detail: string): Promise<void> {
  await page.evaluate(
    (payload) => {
      const id = "__voice_supervisor_overlay__";
      let root = document.getElementById(id);
      if (!root) {
        root = document.createElement("div");
        root.id = id;
        root.setAttribute(
          "style",
          [
            "position: fixed",
            "left: 12px",
            "top: 12px",
            "z-index: 2147483647",
            "max-width: 460px",
            "background: rgba(17, 24, 39, 0.94)",
            "border: 1px solid rgba(255,255,255,0.24)",
            "border-radius: 10px",
            "padding: 10px 12px",
            "box-shadow: 0 6px 18px rgba(0,0,0,0.45)",
            "font-family: Arial, sans-serif",
            "color: #f9fafb",
            "font-size: 13px",
            "line-height: 1.35"
          ].join(";")
        );
        document.body.appendChild(root);
      }
      root.innerHTML = `
        <div style="font-size:14px;font-weight:700;">${escapeHtml(payload.title)}</div>
        <div style="margin-top:5px;opacity:.95;">${escapeHtml(payload.detail)}</div>
      `;

      function escapeHtml(value: unknown): string {
        return String(value)
          .replaceAll("&", "&amp;")
          .replaceAll("<", "&lt;")
          .replaceAll(">", "&gt;");
      }
    },
    { title, detail }
  );
}
