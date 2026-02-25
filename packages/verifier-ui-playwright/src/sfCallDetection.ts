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
  | "voice_tab_delta"
  | "voice_number_delta"
  | "inbox_delta"
  | "timeout";

// ── VoiceCall tab helpers ────────────────────────────────────────────────────

export function voiceCallTabs(page: Page): Locator {
  return page.locator('[role="tab"]').filter({ hasText: /VC-\d+|Voice\s*Call|VoiceCall/i });
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
    page.locator("button[title*='Hang up' i], button[aria-label*='Hang up' i]").first()
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
