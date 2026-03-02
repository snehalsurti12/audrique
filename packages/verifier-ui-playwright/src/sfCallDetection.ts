/**
 * sfCallDetection.ts — Incoming call detection primitives: UI indicators,
 * VoiceCall tab counting, inbox monitoring, and connected-call detection.
 *
 * Extracted from salesforce-voice.spec.ts (Phase A, Step 1).
 */

import type { Locator, Page } from "@playwright/test";

// ── Types ────────────────────────────────────────────────────────────────────

export type IncomingSignalType =
  | "accept_clicked"
  | "incoming_indicator"
  | "connected_indicator"
  | "voice_tab_delta"
  | "voice_number_delta"
  | "inbox_delta"
  | "timeout";

// ── VoiceCall tab helpers ────────────────────────────────────────────────────

export function voiceCallTabs(page: Page): Locator {
  return page.locator('[role="tab"]').filter({
    hasText: /VC-\d+|Voice\s*Call|VoiceCall|New\s+Voice|Call\s+\d|Inbound\s+Call|\+\d{1,3}\s*\(\d/i,
  });
}

export async function countVoiceCallTabs(page: Page): Promise<number> {
  return voiceCallTabs(page).count();
}

export async function getMaxVoiceCallNumber(page: Page): Promise<number> {
  const tabTexts = await voiceCallTabs(page).allInnerTexts().catch(() => []);
  const numbers = tabTexts
    .map((text) => {
      const match = text.match(/VC-(\d+)/i);
      return match ? Number(match[1]) : Number.NaN;
    })
    .filter((value) => Number.isFinite(value)) as number[];
  return numbers.length > 0 ? Math.max(...numbers) : 0;
}

// ── Inbox count ──────────────────────────────────────────────────────────────

export async function getInboxCount(page: Page): Promise<number> {
  const candidates = [
    page.getByText(/inbox \((\d+)\)/i).first(),
    page.locator("text=/Inbox\\s*\\((\\d+)\\)/i").first()
  ];
  for (const candidate of candidates) {
    if ((await candidate.count()) > 0) {
      const text = (await candidate.textContent().catch(() => "")) ?? "";
      const m = text.match(/Inbox\s*\((\d+)\)/i);
      if (m) {
        return Number(m[1]);
      }
    }
  }
  return 0;
}

// ── Incoming call UI indicator ───────────────────────────────────────────────

export async function hasIncomingUiIndicator(page: Page): Promise<boolean> {
  const indicators = [
    page.getByRole("button", { name: /^accept$/i }).first(),
    page.getByText(/incoming call|inbound call/i).first(),
    page.locator('[data-testid="voice-incoming-toast"]').first()
  ];
  for (const indicator of indicators) {
    if ((await indicator.count()) > 0 && (await indicator.isVisible().catch(() => false))) {
      return true;
    }
  }
  return false;
}

// ── Connected call UI indicator ──────────────────────────────────────────────

export async function hasConnectedCallUiIndicator(page: Page): Promise<boolean> {
  const indicators = [
    page.getByRole("button", { name: /end call|hang up|disconnect/i }).first(),
    page.getByRole("button", { name: /close contact/i }).first(),
    page.getByText(/after call work/i).first(),
    page.locator("button[title*='End call' i], button[aria-label*='End call' i]").first(),
    page.locator("button[title*='Hang up' i], button[aria-label*='Hang up' i]").first(),
    // SCV active-call controls within Omni-Channel Phone tab
    page.getByRole("button", { name: /^hold$/i }).first(),
    page.getByRole("button", { name: /^mute$/i }).first(),
    page.getByRole("button", { name: /^transfer$/i }).first(),
    page.locator("button[title*='Hold' i][title*='call' i], button[aria-label*='Hold' i]").first(),
    // Connected call timer / duration indicator
    page.locator("[class*='callTimer' i], [class*='call-timer' i], [class*='callDuration' i]").first(),
  ];
  for (const indicator of indicators) {
    if ((await indicator.count()) > 0 && (await indicator.isVisible().catch(() => false))) {
      return true;
    }
  }
  return false;
}

export async function waitForConnectedCallIndicator(page: Page, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await hasConnectedCallUiIndicator(page)) {
      return true;
    }
    await page.waitForTimeout(500);
  }
  return false;
}

// ── Post-call cleanup ────────────────────────────────────────────────────────

/**
 * End any active call in the Salesforce Omni-Channel Phone tab by clicking
 * the "End Call" button, then wait for ACW/call-ended state.
 */
export async function endActiveCallInSalesforce(page: Page): Promise<boolean> {
  const endCallCandidates = [
    page.getByRole("button", { name: /end call/i }).first(),
    page.locator("button[title*='End call' i], button[aria-label*='End call' i]").first(),
    page.getByRole("button", { name: /hang up|disconnect/i }).first(),
  ];
  for (const button of endCallCandidates) {
    if ((await button.count()) > 0 && (await button.isVisible().catch(() => false))) {
      const disabled = await button.isDisabled().catch(() => true);
      if (!disabled) {
        await button.click({ force: true }).catch(() => undefined);
        await page.waitForTimeout(2000);
        return true;
      }
    }
  }
  return false;
}

/**
 * Close all VoiceCall workspace tabs (VC-*) to clean up stale tabs from
 * previous scenarios and complete ACW. Iterates from last to first to
 * avoid index shifting issues.
 */
export async function closeAllVoiceCallTabs(page: Page): Promise<number> {
  let closed = 0;
  const maxIterations = 20; // safety guard

  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    const tabs = voiceCallTabs(page);
    const count = await tabs.count();
    if (count === 0) {
      break;
    }

    // Click the last VoiceCall tab to select it
    const lastTab = tabs.last();
    const tabText = ((await lastTab.innerText().catch(() => "")) ?? "").trim();
    await lastTab.click({ force: true }).catch(() => undefined);
    await page.waitForTimeout(300);

    // Try to find the close button for this specific tab.
    // When selected, SF names it "Close VC-XXXXX"; otherwise generic "Close Tab".
    let closeClicked = false;

    // 1. Try specific close button: "Close VC-00000NNN"
    const vcMatch = tabText.match(/VC-\d+/i);
    if (vcMatch) {
      const specificClose = page.getByRole("button", {
        name: new RegExp(`close\\s+${vcMatch[0].replace("-", "\\-")}`, "i"),
      }).first();
      if ((await specificClose.count()) > 0 && (await specificClose.isVisible().catch(() => false))) {
        await specificClose.click({ force: true }).catch(() => undefined);
        closeClicked = true;
      }
    }

    // 2. Fallback: find the "Close Tab" button adjacent to the selected tab
    if (!closeClicked) {
      const closeTabButtons = page.locator(
        'nav[aria-label="Workspaces"] button'
      ).filter({ hasText: /^Close/i });
      const closeCount = await closeTabButtons.count();
      // Click the last "Close" button (likely belongs to the last/selected tab)
      if (closeCount > 0) {
        await closeTabButtons.last().click({ force: true }).catch(() => undefined);
        closeClicked = true;
      }
    }

    if (!closeClicked) {
      // Could not find close button — break to avoid infinite loop
      break;
    }

    await page.waitForTimeout(500);
    closed += 1;
  }

  return closed;
}
