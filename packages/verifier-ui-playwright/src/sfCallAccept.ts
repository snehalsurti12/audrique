/**
 * sfCallAccept.ts — Call acceptance: accept button click, force-accept from
 * Omni inbox, work item selection, and Connection Status dialog management.
 *
 * Extracted from salesforce-voice.spec.ts (Phase A, Step 1).
 */

import type { Page } from "@playwright/test";
import {
  findOmniWidget,
  openOmniWorkPanel,
  focusInboxIfWorkPending,
} from "./sfOmniChannel";

// ── Connection Status dialog ─────────────────────────────────────────────────

export async function minimizeConnectionStatusDialogIfOpen(page: Page): Promise<void> {
  const dialog = page.getByRole("dialog", { name: /connection status/i }).first();
  if ((await dialog.count()) === 0) {
    return;
  }
  const visible = await dialog.isVisible().catch(() => false);
  if (!visible) {
    return;
  }
  const minimizeButton = dialog.getByRole("button", { name: /minimize/i }).first();
  if ((await minimizeButton.count()) > 0 && (await minimizeButton.isVisible().catch(() => false))) {
    await minimizeButton.click({ force: true }).catch(() => undefined);
    await page.waitForTimeout(100);
    return;
  }
  const closeButton = dialog.getByRole("button", { name: /close/i }).first();
  if ((await closeButton.count()) > 0 && (await closeButton.isVisible().catch(() => false))) {
    await closeButton.click({ force: true }).catch(() => undefined);
    await page.waitForTimeout(100);
    return;
  }
  await page.keyboard.press("Escape").catch(() => undefined);
  await page.waitForTimeout(100);
}

// ── Accept control ───────────────────────────────────────────────────────────

export async function clickAcceptControl(page: Page): Promise<boolean> {
  await minimizeConnectionStatusDialogIfOpen(page);

  const acceptCandidates = [
    page.getByRole("button", { name: /accept work|accept call/i }).first(),
    page.getByRole("button", { name: /^accept$/i }).first(),
    page.locator("button").filter({ hasText: /^accept$/i }).first(),
    page.locator('[data-testid="voice-accept"]').first(),
    page.getByRole("button", { name: /accept work|accept call|take call|pick up/i }).first(),
    page.getByRole("button", { name: /accept|answer/i }).first(),
    page.getByRole("button", { name: /open work|open details/i }).first(),
    page.locator("button[title*='Accept' i], button[aria-label*='Accept' i]").first(),
    page.locator("button[title*='Answer' i], button[aria-label*='Answer' i]").first(),
    page.locator("div[role='button']").filter({ hasText: /accept|answer|take|open/i }).first(),
    page.locator("a[role='button']").filter({ hasText: /accept|answer|take|open/i }).first()
  ];

  for (const acceptButton of acceptCandidates) {
    if ((await acceptButton.count()) === 0) {
      continue;
    }
    const visible = await acceptButton.isVisible().catch(() => false);
    if (!visible) {
      continue;
    }
    await acceptButton.click({ force: true }).catch(() => undefined);
    return true;
  }

  await openOmniWorkPanel(page);
  await focusInboxIfWorkPending(page);
  const workItemClicked = await clickLikelyOmniWorkItem(page);
  if (workItemClicked) {
    await page.waitForTimeout(150);
  }

  for (const acceptButton of acceptCandidates) {
    if ((await acceptButton.count()) === 0) {
      continue;
    }
    const visible = await acceptButton.isVisible().catch(() => false);
    if (!visible) {
      continue;
    }
    await acceptButton.click({ force: true }).catch(() => undefined);
    return true;
  }
  return workItemClicked;
}

// ── Accept with retry ────────────────────────────────────────────────────────

export async function acceptCallIfPresented(page: Page): Promise<boolean> {
  // Retry briefly because offer controls render asynchronously.
  const acceptWaitMs = Math.max(5_000, Number(process.env.VOICE_ACCEPT_WAIT_SEC ?? 60) * 1000);
  const deadline = Date.now() + acceptWaitMs;
  while (Date.now() < deadline) {
    const clicked = await clickAcceptControl(page);
    if (clicked) {
      await page.waitForTimeout(700);
      return true;
    }
    await page.waitForTimeout(400);
  }
  return false;
}

// ── Force accept from inbox ──────────────────────────────────────────────────

export async function forceAcceptFromOmniInbox(page: Page): Promise<boolean> {
  await openOmniWorkPanel(page).catch(() => undefined);
  await focusInboxIfWorkPending(page).catch(() => undefined);
  const clicked = await clickLikelyOmniWorkItem(page);
  if (!clicked) {
    return false;
  }
  await page.waitForTimeout(120);
  return await clickAcceptControl(page);
}

// ── Work item selection ──────────────────────────────────────────────────────

export async function clickLikelyOmniWorkItem(page: Page): Promise<boolean> {
  const widget = await findOmniWidget(page);
  if (!widget) {
    return false;
  }
  const workRegex = /inbound|voice call|vc-\d+|a few seconds ago|seconds ago|minutes ago|\+\d{1,2}|\(\d{3}\)|\d{3}[-.\s]\d{3}[-.\s]\d{4}/i;
  const rowCandidates = [
    widget.locator("[role='listitem'], [role='option'], tr, li").filter({ hasText: workRegex }).first(),
    widget
      .locator("div[role='button'], a[role='button'], button, article, div")
      .filter({ hasText: workRegex })
      .first()
  ];

  for (const row of rowCandidates) {
    if ((await row.count()) === 0) {
      continue;
    }
    if (!(await row.isVisible().catch(() => false))) {
      continue;
    }
    const text = ((await row.innerText().catch(() => "")) ?? "").replace(/\s+/g, " ").trim();
    if (!text || /^phone$/i.test(text) || /^inbox\s*\(\d+\)$/i.test(text)) {
      continue;
    }
    await row.click({ force: true }).catch(() => undefined);
    return true;
  }
  return false;
}
