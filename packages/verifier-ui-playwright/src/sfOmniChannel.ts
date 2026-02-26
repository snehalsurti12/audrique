/**
 * sfOmniChannel.ts — Omni-Channel widget detection, status management,
 * phone utility, and work panel interaction.
 *
 * Extracted from salesforce-voice.spec.ts (Phase A, Step 1).
 */

import type { Locator, Page } from "@playwright/test";
import { escapeRegex } from "./sfNavigation";

// ── Utility ──────────────────────────────────────────────────────────────────

export function leftRailButton(page: Page, namePattern: RegExp) {
  return page.locator("div[role='button']").filter({ hasText: namePattern }).first();
}

// ── Widget detection ─────────────────────────────────────────────────────────

export async function findOmniWidget(page: Page): Promise<ReturnType<Page["locator"]> | null> {
  const candidates = [
    page.locator(".widget2StatusGrid").first(),
    page.locator("[class*='omni' i][class*='status' i]").first(),
    page.locator("[data-component-id*='omni' i]").first(),
    page.locator("section,div").filter({ hasText: /change your omni-channel status|omni-channel/i }).first()
  ];
  for (const candidate of candidates) {
    if ((await candidate.count()) > 0 && (await candidate.isVisible().catch(() => false))) {
      return candidate;
    }
  }
  return null;
}

export async function findOmniUtilityToggle(page: Page): Promise<Locator | null> {
  const utilityScope =
    "footer, [class*='utilityBar' i], [class*='utilitybar' i], [role='contentinfo'][aria-label*='Utility Bar' i], [aria-label='Utility Bar']";
  const candidates = [
    page
      .locator(utilityScope)
      .locator("a,button,div[role='tab'],div[role='button']")
      .filter({ hasText: /^omni-channel(?:\s*\(.*\))?$/i })
      .first(),
    page.getByRole("button", { name: /^omni-channel(?:\s*\(.*\))?$/i }).first(),
    page.getByRole("tab", { name: /^omni-channel(?:\s*\(.*\))?$/i }).first()
  ];
  for (const candidate of candidates) {
    if ((await candidate.count()) === 0) {
      continue;
    }
    if (!(await candidate.isVisible().catch(() => false))) {
      continue;
    }
    if (await isLikelySettingsControl(candidate)) {
      continue;
    }
    return candidate;
  }
  return null;
}

// ── Settings view ────────────────────────────────────────────────────────────

export async function isLikelyOmniStatusControl(locator: Locator): Promise<boolean> {
  return locator
    .evaluate((el) => {
      const attrs = `${el.getAttribute("aria-label") ?? ""} ${el.getAttribute("title") ?? ""}`.toLowerCase();
      const text = ((el as HTMLElement).innerText ?? "").toLowerCase();
      const role = (el.getAttribute("role") ?? "").toLowerCase();
      const hasPopup = (el.getAttribute("aria-haspopup") ?? "").toLowerCase();

      const haystack = `${attrs} ${text}`.replace(/\s+/g, " ").trim();
      if (!haystack) {
        return false;
      }

      if (/settings|preferences|configuration|gear|omni-channel settings/.test(haystack)) {
        return false;
      }

      if (/change your omni-channel status|change status/.test(haystack)) {
        return true;
      }

      if (hasPopup === "listbox" || hasPopup === "menu") {
        const container = el.closest("section,article,div") as HTMLElement | null;
        const containerText = (container?.innerText ?? "").toLowerCase();
        const directParentText = ((el.parentElement as HTMLElement | null)?.innerText ?? "").toLowerCase();
        const headerText = (
          (el.closest("header,[class*='header' i],[class*='widgetHeader' i],[class*='panelHeader' i]") as HTMLElement | null)
            ?.innerText ?? ""
        ).toLowerCase();
        const inHeader = Boolean(headerText) && /omni-channel/.test(headerText);
        if (inHeader && !/available for voice|available|offline|busy|on break|away/.test(headerText)) {
          return false;
        }
        if (/settings|browser notifications|ringer output|speaker/i.test(containerText)) {
          return false;
        }
        if (/settings|browser notifications|ringer output|speaker/i.test(directParentText)) {
          return false;
        }
        if (!/change your omni-channel status|change status|available for voice|offline|busy|on break|away/.test(containerText)) {
          return false;
        }
        return true;
      }

      return role === "combobox";
    })
    .catch(() => false);
}

export async function isLikelySettingsControl(locator: Locator): Promise<boolean> {
  return locator
    .evaluate((el) => {
      const text = `${el.getAttribute("aria-label") ?? ""} ${el.getAttribute("title") ?? ""} ${
        (el as HTMLElement).innerText ?? ""
      }`.toLowerCase();
      return /settings|preferences|configuration|gear/.test(text);
    })
    .catch(() => false);
}

export async function isOmniSettingsViewOpen(page: Page): Promise<boolean> {
  const settingsHeader = page
    .locator("section,article,div")
    .filter({ hasText: /^settings$/i })
    .first();
  const browserNotifications = page
    .locator("section,article,div")
    .filter({ hasText: /browser notifications/i })
    .first();
  if ((await settingsHeader.count()) > 0 && (await settingsHeader.isVisible().catch(() => false))) {
    return true;
  }
  if ((await browserNotifications.count()) > 0 && (await browserNotifications.isVisible().catch(() => false))) {
    return true;
  }
  return false;
}

export async function clickOmniSettingsBackFallback(page: Page): Promise<boolean> {
  const widget = await findOmniWidget(page);
  if (!widget) {
    return false;
  }
  return widget
    .evaluate((rootNode) => {
      const root = rootNode as HTMLElement;
      const rootRect = root.getBoundingClientRect();
      const isVisible = (el: HTMLElement) => {
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      const textOf = (el: HTMLElement) =>
        `${el.getAttribute("aria-label") ?? ""} ${el.getAttribute("title") ?? ""} ${el.innerText ?? ""}`
          .replace(/\s+/g, " ")
          .trim()
          .toLowerCase();
      const controls = Array.from(root.querySelectorAll("button,[role='button']")).filter((el) =>
        isVisible(el as HTMLElement)
      ) as HTMLElement[];
      if (controls.length === 0) {
        return false;
      }
      controls.sort((a, b) => {
        const ar = a.getBoundingClientRect();
        const br = b.getBoundingClientRect();
        if (Math.abs(ar.top - br.top) > 6) {
          return ar.top - br.top;
        }
        return ar.left - br.left;
      });

      const labeledBack = controls.find((control) => /back|omni-channel/.test(textOf(control)));
      if (labeledBack) {
        labeledBack.click();
        return true;
      }

      const iconBack = controls.find((control) => {
        const text = textOf(control);
        if (/save|cancel|sync|test|run|close|minimize/.test(text)) {
          return false;
        }
        const rect = control.getBoundingClientRect();
        const nearTopLeft = rect.top < rootRect.top + 130 && rect.left < rootRect.left + 120;
        return nearTopLeft && rect.width <= 56 && rect.height <= 56;
      });
      if (iconBack) {
        iconBack.click();
        return true;
      }

      return false;
    })
    .catch(() => false);
}

export async function exitOmniSettingsViewIfOpen(page: Page): Promise<void> {
  if (!(await isOmniSettingsViewOpen(page))) {
    return;
  }

  const backCandidates = [
    page.getByRole("button", { name: /back|omni-channel/i }).first(),
    page.locator("button[title*='Back' i], button[aria-label*='Back' i]").first(),
    page.locator("button").filter({ hasText: /back/i }).first(),
    page
      .locator("section,article,div")
      .filter({ hasText: /^settings$/i })
      .first()
      .locator("button, [role='button']")
      .first()
  ];
  for (const candidate of backCandidates) {
    if ((await candidate.count()) === 0) {
      continue;
    }
    if (!(await candidate.isVisible().catch(() => false))) {
      continue;
    }
    await candidate.click({ force: true }).catch(() => undefined);
    await page.waitForTimeout(250);
    if (!(await isOmniSettingsViewOpen(page))) {
      return;
    }
  }

  const fallbackClicked = await clickOmniSettingsBackFallback(page);
  if (fallbackClicked) {
    await page.waitForTimeout(220);
    if (!(await isOmniSettingsViewOpen(page))) {
      return;
    }
  }

  await page.keyboard.press("Escape").catch(() => undefined);
  await page.waitForTimeout(250);
}

// ── Work panel ───────────────────────────────────────────────────────────────

export async function isOmniWorkPanelOpen(page: Page): Promise<boolean> {
  if (await isOmniSettingsViewOpen(page)) {
    return false;
  }
  const header = page
    .locator("section,article,div")
    .filter({ hasText: /^omni-channel$/i })
    .first();
  if ((await header.count()) > 0 && (await header.isVisible().catch(() => false))) {
    return true;
  }
  const availability = page
    .locator("section,article,div")
    .filter({ hasText: /available for voice|offline|busy|on break/i })
    .first();
  return (await availability.count()) > 0 && (await availability.isVisible().catch(() => false));
}

export async function openOmniWorkPanel(page: Page): Promise<void> {
  await exitOmniSettingsViewIfOpen(page);
  if (await isOmniWorkPanelOpen(page)) {
    return;
  }

  const utilityToggle = await findOmniUtilityToggle(page);
  if (utilityToggle) {
    await utilityToggle.click({ force: true }).catch(() => undefined);
    await page.waitForTimeout(120);
    if (await isOmniWorkPanelOpen(page)) {
      return;
    }
  }

  const candidates = [
    page.getByRole("tab", { name: /omni-channel|omni/i }).first(),
    page
      .locator(
        "footer a, footer button, footer div[role='tab'], footer div[role='button'], [role='contentinfo'][aria-label*='Utility Bar' i] a, [role='contentinfo'][aria-label*='Utility Bar' i] button, [role='contentinfo'][aria-label*='Utility Bar' i] div[role='tab'], [role='contentinfo'][aria-label*='Utility Bar' i] div[role='button'], [aria-label='Utility Bar'] a, [aria-label='Utility Bar'] button, [aria-label='Utility Bar'] div[role='tab'], [aria-label='Utility Bar'] div[role='button']"
      )
      .filter({ hasText: /^omni-channel(?:\s*\(.*\))?$/i })
      .first(),
    page
      .locator("a,button,div[role='tab'],div[role='button']")
      .filter({ hasText: /^omni-channel(?:\s*\(.*\))?$/i })
      .first()
  ];
  for (const target of candidates) {
    if ((await target.count()) === 0) {
      continue;
    }
    if (!(await target.isVisible().catch(() => false))) {
      continue;
    }
    const ariaSelected = ((await target.getAttribute("aria-selected").catch(() => "")) ?? "").toLowerCase();
    if (ariaSelected === "true" && (await isOmniWorkPanelOpen(page))) {
      return;
    }
    if (await isLikelySettingsControl(target)) {
      continue;
    }
    await target.click({ force: true }).catch(() => undefined);
    await page.waitForTimeout(120);
    if (await isOmniWorkPanelOpen(page)) {
      return;
    }
  }
}

export async function openOmniWidget(page: Page): Promise<void> {
  await openOmniWorkPanel(page).catch(() => undefined);
  await exitOmniSettingsViewIfOpen(page).catch(() => undefined);
  const existing = await findOmniWidget(page);
  if (existing) {
    return;
  }

  const clicks = [
    await findOmniUtilityToggle(page),
    page.getByRole("tab", { name: /^omni-channel(?:\s*\(.*\))?$/i }).first(),
    page.getByRole("button", { name: /^omni-channel(?:\s*\(.*\))?$/i }).first(),
    page.getByRole("tab", { name: /^omni-channel$/i }).first(),
    page.getByRole("button", { name: /^omni-channel$/i }).first(),
    leftRailButton(page, /^omni-channel$/i)
  ];
  for (const target of clicks) {
    if (!target) {
      continue;
    }
    if ((await target.count()) === 0) {
      continue;
    }
    if (!(await target.isVisible().catch(() => false))) {
      continue;
    }
    if (await isLikelySettingsControl(target)) {
      continue;
    }
    await target.click({ force: true }).catch(() => undefined);
    await page.waitForTimeout(350);
    await exitOmniSettingsViewIfOpen(page).catch(() => undefined);
    const widget = await findOmniWidget(page);
    if (widget) {
      return;
    }
  }
}

// ── Phone tab ────────────────────────────────────────────────────────────────

export async function ensureOmniPhoneTabSelectedIfVisible(page: Page): Promise<void> {
  const phoneTab = page.getByRole("tab", { name: /^phone$/i }).first();
  if ((await phoneTab.count()) > 0 && (await phoneTab.isVisible().catch(() => false))) {
    const selected = ((await phoneTab.getAttribute("aria-selected").catch(() => "")) ?? "").toLowerCase();
    if (selected !== "true") {
      await phoneTab.click({ force: true }).catch(() => undefined);
      await page.waitForTimeout(120);
    }
  }
}

export async function ensureOmniPhoneTabOpen(page: Page): Promise<void> {
  await openOmniWorkPanel(page).catch(() => undefined);
  await exitOmniSettingsViewIfOpen(page).catch(() => undefined);
  await ensureOmniPhoneTabSelectedIfVisible(page).catch(() => undefined);
}

export async function ensurePhoneUtilityOpen(page: Page): Promise<void> {
  const inboxLeftRail = leftRailButton(page, /^inbox$/i);
  if ((await inboxLeftRail.count()) > 0) {
    await inboxLeftRail.click({ force: true });
    await page.waitForTimeout(400);
  }

  const phoneLeftRail = leftRailButton(page, /^phone$/i);
  if ((await phoneLeftRail.count()) > 0) {
    await phoneLeftRail.click({ force: true });
    await page.waitForTimeout(500);
    return;
  }

  const sidebarPhoneText = page.getByText(/^Phone$/i).first();
  if (
    (await sidebarPhoneText.count()) > 0 &&
    (await sidebarPhoneText.isVisible().catch(() => false))
  ) {
    await sidebarPhoneText.click({ force: true });
    await page.waitForTimeout(500);
    return;
  }

  const sidebarPhoneTab = page.getByRole("tab", { name: /^phone$/i }).first();
  if ((await sidebarPhoneTab.count()) > 0 && (await sidebarPhoneTab.isVisible().catch(() => false))) {
    await sidebarPhoneTab.click({ force: true });
    await page.waitForTimeout(500);
    return;
  }

  const phoneButton = page.getByRole("button", { name: /^phone$/i }).first();
  if ((await phoneButton.count()) > 0 && (await phoneButton.isVisible().catch(() => false))) {
    await phoneButton.click({ force: true });
    await page.waitForTimeout(500);
  }
}

// ── Inbox ────────────────────────────────────────────────────────────────────

export async function focusInboxIfWorkPending(page: Page): Promise<void> {
  const inboxTabs = page.locator('[role="tab"]').filter({ hasText: /^inbox\s*\(\d+\)/i });
  if ((await inboxTabs.count()) === 0) {
    return;
  }

  const inboxTab = inboxTabs.first();
  const tabText = ((await inboxTab.innerText().catch(() => "")) ?? "").trim();
  const match = tabText.match(/inbox\s*\((\d+)\)/i);
  const pending = match ? Number(match[1]) : 0;
  if (pending <= 0) {
    return;
  }

  await inboxTab.click({ force: true }).catch(() => undefined);
  await page.waitForTimeout(150);
}

// ── Status change button detection ───────────────────────────────────────────

export async function findOmniStatusChangeButton(page: Page): Promise<ReturnType<Page["locator"]> | null> {
  const widget = await findOmniWidget(page);
  if (widget) {
    const presenceRowCandidates = [
      widget
        .locator("section,article,div")
        .filter({ hasText: /available for voice|available|offline|busy|on break|away/i })
        .first()
        .locator(
          "button[aria-label*='status' i], button[title*='status' i], [role='button'][aria-label*='status' i], [role='button'][title*='status' i], [role='combobox'], [role='button'][aria-haspopup='listbox'], [role='button'][aria-haspopup='menu']"
        )
        .first(),
      widget
        .locator("section,article,div")
        .filter({ hasText: /available for voice|available|offline|busy|on break|away/i })
        .first()
        .locator("button, [role='button'], [role='combobox']")
        .first()
    ];
    for (const candidate of presenceRowCandidates) {
      if ((await candidate.count()) === 0) {
        continue;
      }
      if (!(await candidate.isVisible().catch(() => false))) {
        continue;
      }
      if (!(await isLikelyOmniStatusControl(candidate))) {
        continue;
      }
      return candidate;
    }

    const widgetCandidates = [
      widget
        .getByRole("button", {
          name: /change your omni-channel status/i
        })
        .first(),
      widget
        .locator(
          "button[aria-label*='Change your Omni-Channel status' i], button[title*='Change your Omni-Channel status' i], [role='button'][aria-label*='Change your Omni-Channel status' i], [role='button'][title*='Change your Omni-Channel status' i]"
        )
        .first(),
      widget
        .locator(
          "[role='combobox'][aria-label*='status' i], [role='button'][aria-label*='status' i], [role='button'][title*='status' i], [role='button'][aria-haspopup='listbox']"
        )
        .first(),
      widget
        .locator(
          "button[aria-haspopup='listbox'][aria-label*='status' i], button[title*='status' i], button[aria-label*='status' i]"
        )
        .first(),
      widget.locator(".widget2StatusGrid button[aria-haspopup='listbox']").first()
    ];
    for (const candidate of widgetCandidates) {
      if ((await candidate.count()) === 0) {
        continue;
      }
      if (!(await candidate.isVisible().catch(() => false))) {
        continue;
      }
      if (!(await isLikelyOmniStatusControl(candidate))) {
        continue;
      }
      return candidate;
    }
  }

  const fallbackButtons = [
    page.getByRole("button", { name: /change your omni-channel status/i }).first(),
    page
      .locator("[role='combobox'], div[role='button'], button")
      .filter({ hasText: /change your omni-channel status|change status/i })
      .first(),
    page.locator("button[title*='Omni' i], button[aria-label*='Omni' i]").first(),
    page.locator("button").filter({ hasText: /change your omni-channel status|change status/i }).first()
  ];
  for (const candidate of fallbackButtons) {
    if ((await candidate.count()) > 0 && (await candidate.isVisible().catch(() => false))) {
      if (await isLikelyOmniStatusControl(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

// ── Status reading ───────────────────────────────────────────────────────────

export async function readOmniStatusTextFallback(page: Page): Promise<string> {
  const bodyText = await page.locator("body").innerText().catch(() => "");
  const lines = bodyText
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  for (let i = 0; i < lines.length; i += 1) {
    if (!/omni-channel|change your omni-channel status|omni/i.test(lines[i])) {
      continue;
    }
    for (let j = i + 1; j < Math.min(lines.length, i + 6); j += 1) {
      if (/\b(available|offline|busy|away|on break)\b/i.test(lines[j])) {
        return lines[j];
      }
    }
  }
  return "";
}

export async function readOmniUtilityStatusText(page: Page): Promise<string> {
  const utility = page
    .locator(
      "footer, [class*='utilityBar' i], [class*='utilitybar' i], [role='contentinfo'][aria-label*='Utility Bar' i], [aria-label='Utility Bar']"
    )
    .locator("a,button,div[role='tab'],div[role='button'],span")
    .filter({ hasText: /omni-channel/i })
    .first();
  if ((await utility.count()) === 0) {
    return "";
  }
  if (!(await utility.isVisible().catch(() => false))) {
    return "";
  }
  const text = ((await utility.innerText().catch(() => "")) ?? "").replace(/\s+/g, " ").trim();
  return text;
}

export async function readOmniObservedStatusText(page: Page): Promise<string> {
  const widget = await findOmniWidget(page);
  if (widget) {
    const text = ((await widget.innerText().catch(() => "")) ?? "").replace(/\s+/g, " ").trim();
    if (/\b(available|offline|busy|away|on break|online|logging in)\b/i.test(text)) {
      return text;
    }
  }

  const fallback = await readOmniStatusTextFallback(page);
  if (fallback) {
    return fallback;
  }
  const utilityStatus = await readOmniUtilityStatusText(page);
  if (utilityStatus) {
    return utilityStatus;
  }
  return "";
}

// ── Status assertions ────────────────────────────────────────────────────────

export function assertOmniStatusText(text: string, targetOmniStatus: string): string {
  const observed = text.toLowerCase();
  const target = targetOmniStatus.toLowerCase().trim();

  if (/\boffline\b/i.test(observed)) {
    throw new Error(`Omni-Channel is Offline. Current widget text="${text}"`);
  }
  if (/\blogging in\b/i.test(observed)) {
    throw new Error(`Omni-Channel is still logging in. Current widget text="${text}"`);
  }

  const exactMatcher = new RegExp(`\\b${escapeRegex(targetOmniStatus)}\\b`, "i");
  if (exactMatcher.test(text)) {
    return text;
  }

  // Salesforce surfaces presence differently across widgets:
  // e.g. "Available for Voice", "Available", or utility text "Omni-Channel (Online)".
  const targetWantsAvailability =
    /\bavailable\b/.test(target) || /\bonline\b/.test(target) || /available for voice/.test(target);
  const observedIsAvailableLike =
    /\bavailable\b/.test(observed) || /\bonline\b/.test(observed);
  if (targetWantsAvailability && observedIsAvailableLike) {
    return text;
  }

  throw new Error(`Omni-Channel status mismatch. Expected "${targetOmniStatus}", observed "${text}".`);
}

export async function assertOmniStatus(page: Page, targetOmniStatus: string): Promise<string> {
  const waitMs = Number(process.env.OMNI_READY_WAIT_SEC ?? 20) * 1000;
  const deadline = Date.now() + waitMs;
  let lastObserved = "";
  let lastError = "";

  while (Date.now() < deadline) {
    const observed = await readOmniObservedStatusText(page);
    if (!observed) {
      await openOmniWorkPanel(page).catch(() => undefined);
      await page.waitForTimeout(500);
      continue;
    }

    lastObserved = observed;
    try {
      return assertOmniStatusText(observed, targetOmniStatus);
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      await page.waitForTimeout(500);
    }
  }

  if (lastError) {
    throw new Error(`${lastError} (waited ${waitMs / 1000}s; lastObserved="${lastObserved}")`);
  }
  throw new Error(`Omni-Channel status could not be determined within ${waitMs / 1000}s.`);
}

// ── Status change ────────────────────────────────────────────────────────────

export async function chooseOmniStatusFallback(page: Page, targetStatus: string): Promise<boolean> {
  const targetRegex = new RegExp(escapeRegex(targetStatus), "i");
  const directCandidates = [
    page.getByRole("option", { name: targetRegex }).first(),
    page.getByRole("menuitemradio", { name: targetRegex }).first(),
    page.getByRole("menuitem", { name: targetRegex }).first(),
    page.getByRole("button", { name: targetRegex }).first(),
    page.locator("lightning-base-combobox-item, [data-value], [value]").filter({ hasText: targetRegex }).first(),
    page
      .locator("a,button,div[role='option'],div[role='menuitemradio'],div[role='menuitem']")
      .filter({ hasText: targetRegex })
      .first()
  ];

  for (const candidate of directCandidates) {
    if ((await candidate.count()) === 0) {
      continue;
    }
    if (!(await candidate.isVisible().catch(() => false))) {
      continue;
    }
    await candidate.click({ force: true }).catch(() => undefined);
    const observed = await readOmniObservedStatusText(page);
    if (targetRegex.test(observed) || (/available|online/i.test(targetStatus) && /available|online/i.test(observed))) {
      return true;
    }
  }

  // Final fallback: select first visible non-offline status option if target is an available-like status.
  if (/available|online/i.test(targetStatus)) {
    const fallbackOption = page
      .locator("lightning-base-combobox-item, [role='option'], [role='menuitemradio'], [role='menuitem']")
      .filter({ hasNotText: /offline/i })
      .first();
    if ((await fallbackOption.count()) > 0 && (await fallbackOption.isVisible().catch(() => false))) {
      await fallbackOption.click({ force: true }).catch(() => undefined);
      const observed = await readOmniObservedStatusText(page);
      if (/available|online/i.test(observed)) {
        return true;
      }
    }
  }

  return false;
}

export async function forceOmniStatusSelection(page: Page, targetStatus: string): Promise<void> {
  await openOmniWorkPanel(page).catch(() => undefined);
  await exitOmniSettingsViewIfOpen(page).catch(() => undefined);
  const statusControl = await findOmniStatusChangeButton(page);
  if (!statusControl) {
    return;
  }
  await statusControl.click({ force: true }).catch(() => undefined);
  await page.waitForTimeout(250);
  const selected = await chooseOmniStatusFallback(page, targetStatus);
  if (selected) {
    await page.waitForTimeout(500);
    return;
  }

  // Keyboard fallback for comboboxes that do not expose menu items to locators.
  await page.keyboard.press("ArrowDown").catch(() => undefined);
  await page.waitForTimeout(120);
  await page.keyboard.press("Enter").catch(() => undefined);
  await page.waitForTimeout(450);
}

export async function ensureOmniStatus(page: Page, targetStatus: string): Promise<void> {
  if (!targetStatus) {
    return;
  }

  await openOmniWidget(page);
  await dismissOmniAnotherLocationBanner(page);
  await exitOmniSettingsViewIfOpen(page);

  const beforeText = await readOmniObservedStatusText(page);
  if (beforeText) {
    try {
      assertOmniStatusText(beforeText, targetStatus);
      await ensureOmniPhoneTabOpen(page);
      return;
    } catch {
      // Continue and attempt status change.
    }
  }

  let changeStatusButton = await findOmniStatusChangeButton(page);
  if (!changeStatusButton) {
    await ensureOmniPhoneTabOpen(page);
    return;
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    await changeStatusButton.click({ force: true }).catch(() => undefined);
    await page.waitForTimeout(650);
    if (!(await isOmniSettingsViewOpen(page))) {
      break;
    }
    await exitOmniSettingsViewIfOpen(page);
    await page.waitForTimeout(350);
    changeStatusButton = await findOmniStatusChangeButton(page);
    if (!changeStatusButton) {
      return;
    }
  }

  const optionsLocator = page.locator(
    "lightning-base-combobox-item, [role='option'], [role='menuitemradio'], [role='menuitem'], .slds-listbox__option"
  );
  let optionsCount = 0;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    optionsCount = await optionsLocator.count();
    if (optionsCount > 0) {
      break;
    }
    await page.waitForTimeout(400);
  }
  if (optionsCount === 0) {
    const selected = await chooseOmniStatusFallback(page, targetStatus);
    if (selected) {
      await page.waitForTimeout(700);
      await ensureOmniPhoneTabOpen(page);
      return;
    }
    // If dropdown does not render in headless mode, at least record current status text.
    const currentStatusText = (await page
      .locator(".widget2StatusGrid .offlineStatus, .widget2StatusGrid .truncatedText")
      .first()
      .textContent()
      .catch(() => ""))?.trim() ?? "";
    if (new RegExp(targetStatus, "i").test(currentStatusText)) {
      await ensureOmniPhoneTabOpen(page);
      return;
    }
    await ensureOmniPhoneTabOpen(page);
    return;
  }

  const option = optionsLocator.filter({ hasText: new RegExp(targetStatus, "i") }).first();

  if ((await option.count()) === 0) {
    const availableOptions = (
      await page
        .locator('[role="menuitemradio"], [role="option"], [role="menuitem"]')
        .allTextContents()
        .catch(() => [])
    )
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, 15);
    throw new Error(
      `Could not find Omni status matching "${targetStatus}". Visible options: ${availableOptions.join(", ")}`
    );
  }

  const optionVisible = await option.isVisible().catch(() => false);
  if (!optionVisible) {
    await page.keyboard.press("Escape").catch(() => undefined);
    await page.waitForTimeout(250);
    return;
  }

  try {
    await option.click({ force: true });
    await page.waitForTimeout(1000);
    await ensureOmniPhoneTabOpen(page);
  } catch {
    // Dropdown can collapse between lookup and click in Lightning.
    await page.keyboard.press("Escape").catch(() => undefined);
    await page.waitForTimeout(250);
    await ensureOmniPhoneTabOpen(page);
  }
}

// ── Banners ──────────────────────────────────────────────────────────────────

export async function dismissPresenceAppSwitchBanner(page: Page): Promise<void> {
  // Salesforce shows "Unable to log you in to this app using presence status Available for Voice"
  // when a same-context tab tries to switch apps while the agent has a voice-specific status.
  // Dismiss the banner and continue — the supervisor surface may still be accessible.
  const banner = page.getByText(/unable to log you in to this app/i).first();
  if ((await banner.count()) === 0) {
    return;
  }
  const closeButton = page.locator("button[title='Close' i], button[aria-label='Close' i]")
    .or(banner.locator("xpath=ancestor::div[1]//button | ../button | ../../button").first())
    .first();
  if ((await closeButton.count()) > 0 && (await closeButton.isVisible().catch(() => false))) {
    await closeButton.click({ force: true }).catch(() => undefined);
    await page.waitForTimeout(500);
  }
}

export async function dismissOmniAnotherLocationBanner(page: Page): Promise<void> {
  // Salesforce shows "You have logged in from another location." with an X button
  // when the same user session opens in a new browser context. This forces Omni
  // to Offline and must be dismissed before status can be changed.
  const banner = page.getByText(/logged in from another location/i).first();
  if ((await banner.count()) === 0 || !(await banner.isVisible().catch(() => false))) {
    return;
  }
  // The dismiss (X/close) button is in the same container as the banner text.
  const container = banner.locator("xpath=ancestor::div[contains(@class,'slds-notify') or contains(@class,'notification') or position()<=3]").first();
  const closeButton = container.locator("button").first();
  if ((await closeButton.count()) > 0 && (await closeButton.isVisible().catch(() => false))) {
    await closeButton.click({ force: true }).catch(() => undefined);
    await page.waitForTimeout(500);
    return;
  }
  // Fallback: find any close/dismiss button adjacent to the banner text.
  const siblingClose = banner.locator("xpath=../button | ../../button").first();
  if ((await siblingClose.count()) > 0) {
    await siblingClose.click({ force: true }).catch(() => undefined);
    await page.waitForTimeout(500);
  }
}

export async function dismissSalesforceSetupDialogs(page: Page): Promise<void> {
  // Salesforce shows various setup/walkthrough modals ("Get Started with Field Service",
  // "Welcome to...", "Try the new...") that block interactions. Dismiss them all.
  const dismissSelectors = [
    // "Dismiss" button on setup modals
    page.getByRole("button", { name: /^dismiss$/i }).first(),
    // Generic close button on modal dialogs
    page.locator("div[role='dialog'] button[title='Close' i]").first(),
    // "Not Now" on walkthrough prompts
    page.getByRole("button", { name: /^not now$/i }).first(),
    // "Maybe Later" on feature prompts
    page.getByRole("button", { name: /^maybe later$/i }).first(),
    // Close X on modals
    page.locator("div.modal-container button.slds-modal__close").first(),
  ];
  for (const btn of dismissSelectors) {
    if ((await btn.count().catch(() => 0)) > 0 && (await btn.isVisible().catch(() => false))) {
      await btn.click({ force: true }).catch(() => undefined);
      await page.waitForTimeout(500);
    }
  }
}

// ── Offline detection ────────────────────────────────────────────────────────

export async function isOmniOffline(page: Page): Promise<boolean> {
  const widget = await findOmniWidget(page);
  if (widget) {
    const widgetText = ((await widget.innerText().catch(() => "")) ?? "").toLowerCase();
    if (/\boffline\b/.test(widgetText)) {
      return true;
    }
    if (/\bavailable\b|\bonline\b/.test(widgetText)) {
      return false;
    }
  }

  const omniUtility = page
    .locator(
      "footer, [class*='utilityBar' i], [class*='utilitybar' i], [role='contentinfo'][aria-label*='Utility Bar' i], [aria-label='Utility Bar']"
    )
    .locator("a,button,div[role='tab'],div[role='button'],span")
    .filter({ hasText: /omni-channel\s*\(/i })
    .first();
  if ((await omniUtility.count()) > 0 && (await omniUtility.isVisible().catch(() => false))) {
    const text = ((await omniUtility.innerText().catch(() => "")) ?? "").toLowerCase();
    if (/omni-channel\s*\(\s*offline\s*\)/.test(text)) {
      return true;
    }
    if (/omni-channel\s*\(\s*(online|available)\s*\)/.test(text)) {
      return false;
    }
  }

  const fallback = (await readOmniStatusTextFallback(page)).toLowerCase();
  if (/\boffline\b/.test(fallback)) {
    return true;
  }
  return false;
}
