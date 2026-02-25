import fs from "node:fs";
import type { Browser, BrowserContext, Locator, Page } from "@playwright/test";

export interface ConnectCcpDialInput {
  browser: Browser;
  ccpUrl: string;
  storageStatePath: string;
  to: string;
  dialTimeoutMs?: number;
  dtmfDigits?: string;
  dtmfMinCallElapsedSec?: number;
  dtmfInitialDelayMs?: number;
  dtmfInterDigitDelayMs?: number;
  dtmfPostDelayMs?: number;
  videoDir?: string;
}

export interface ConnectCcpSession {
  context: BrowserContext;
  page: Page;
  videoPath?: string;
  dialStartedAtMs?: number;
  end: () => Promise<void>;
}

export async function dialFromConnectCcp(input: ConnectCcpDialInput): Promise<ConnectCcpSession> {
  if (!fs.existsSync(input.storageStatePath)) {
    throw new Error(
      `Connect storage state not found: ${input.storageStatePath}. Run instance:auth:connect first.`
    );
  }

  const context = await input.browser.newContext({
    storageState: input.storageStatePath,
    permissions: ["microphone", "camera"],
    ...(input.videoDir
      ? {
          recordVideo: {
            dir: input.videoDir,
            size: { width: 1280, height: 720 }
          }
        }
      : {})
  });
  const page = await context.newPage();
  await page.goto(input.ccpUrl, { waitUntil: "domcontentloaded" });
  await waitForCcpReady(page, 45_000);
  await ensureAgentAvailable(page, 20_000);

  const bodyText = (await page.locator("body").innerText().catch(() => "")).toLowerCase();
  if (bodyText.includes("session expired")) {
    await context.close();
    throw new Error(
      "Connect CCP session is expired in automation context. Run instance:auth:connect and log in again."
    );
  }

  await dismissBlockingAlerts(page);
  await focusPhoneTab(page);
  await ensureOutboundDialSurface(page);
  await fillDialNumber(page, input.to);
  await dismissBlockingAlerts(page);
  const callButton = await resolveEnabledCallButton(page);
  await callButton.click({ force: true });

  const dialTimeoutMs = input.dialTimeoutMs ?? 15_000;
  const dialStartedAtMs = await waitForDialStart(page, dialTimeoutMs, input.to);
  const dtmfDigits = normalizeDtmfDigits(input.dtmfDigits ?? "");
  if (dtmfDigits) {
    await waitForConnectedCallReadyForDtmf(page, 15_000);
    await waitForCallElapsedAtLeast(page, Math.max(0, Math.floor(input.dtmfMinCallElapsedSec ?? 8)), 30_000);
    await page.waitForTimeout(Math.max(0, input.dtmfInitialDelayMs ?? 0));
    await sendDtmfSequence(page, dtmfDigits, Math.max(40, input.dtmfInterDigitDelayMs ?? 420));
    await page.waitForTimeout(Math.max(0, input.dtmfPostDelayMs ?? 1200));
    await page.screenshot({ path: "test-results/connect-ccp-dtmf-sent.png", fullPage: true }).catch(() => undefined);
  }

  const session: ConnectCcpSession = {
    context,
    page,
    videoPath: undefined,
    dialStartedAtMs,
    end: async () => {
      await endCallIfPresent(page);
      const video = page.video();
      await context.close();
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

async function focusPhoneTab(page: Page): Promise<void> {
  const candidates = [
    page.getByRole("tab", { name: /^phone$/i }).first(),
    page.getByRole("button", { name: /^phone$/i }).first(),
    page.locator('[role="tab"]').filter({ hasText: /^phone$/i }).first()
  ];
  for (const candidate of candidates) {
    if ((await candidate.count()) === 0) {
      continue;
    }
    const visible = await candidate.isVisible().catch(() => false);
    if (!visible) {
      continue;
    }
    await candidate.click({ force: true }).catch(() => undefined);
    await page.waitForTimeout(250);
    return;
  }
}

async function ensureAgentAvailable(page: Page, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const statusButton = await resolveStatusButton(page);
    if (!statusButton) {
      await page.waitForTimeout(250);
      continue;
    }

    const statusText = ((await statusButton.innerText().catch(() => "")) ?? "").toLowerCase();
    if (/\bavailable\b/.test(statusText)) {
      return;
    }

    await statusButton.click({ force: true }).catch(() => undefined);
    await page.waitForTimeout(250);
    const availableOption = page
      .getByRole("option", { name: /^available$/i })
      .or(page.getByRole("menuitemradio", { name: /^available$/i }))
      .or(page.getByRole("menuitem", { name: /^available$/i }))
      .or(page.getByRole("button", { name: /^available$/i }))
      .or(page.locator("li,button,div[role='option'],div[role='menuitemradio']").filter({ hasText: /^available$/i }))
      .first();
    if ((await availableOption.count()) > 0 && (await availableOption.isVisible().catch(() => false))) {
      await availableOption.click({ force: true }).catch(() => undefined);
      await page.waitForTimeout(400);
    } else {
      await page.keyboard.press("Escape").catch(() => undefined);
      await page.waitForTimeout(150);
    }
  }

  await page.screenshot({ path: "test-results/connect-ccp-status-not-available.png", fullPage: true }).catch(() => undefined);
  throw new Error("Connect CCP agent status did not become Available before dialing.");
}

async function resolveStatusButton(page: Page) {
  const candidates = [
    page.locator("header, [class*='top' i], [class*='status' i]").getByRole("button", {
      name: /offline|available|busy|after call work|change status/i
    }).first(),
    page.getByRole("button", { name: /offline|available|busy|after call work|change status/i }).first(),
    page.locator("button").filter({ hasText: /offline|available|busy|after call work/i }).first()
  ];
  for (const candidate of candidates) {
    if ((await candidate.count()) === 0) {
      continue;
    }
    if (await candidate.isVisible().catch(() => false)) {
      return candidate;
    }
  }
  return null;
}

async function waitForCcpReady(page: Page, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let triedStatusSet = false;
  while (Date.now() < deadline) {
    const bodyText = (await page.locator("body").innerText().catch(() => "")).toLowerCase();
    if (bodyText.includes("session expired")) {
      throw new Error("Connect CCP session expired while waiting for readiness.");
    }

    const initializing = bodyText.includes("initializing");
    const numberPadVisible = await page
      .getByRole("button", { name: /number pad/i })
      .first()
      .isVisible()
      .catch(() => false);
    const quickConnectVisible = await page
      .getByRole("button", { name: /quick connects/i })
      .first()
      .isVisible()
      .catch(() => false);

    if (!triedStatusSet && /change status/i.test(bodyText)) {
      triedStatusSet = true;
      await setAvailableStatusIfPrompted(page);
    }

    if (!initializing && (numberPadVisible || quickConnectVisible)) {
      return;
    }

    // If a prior contact left the CCP in "Missed call" / ACW state, click
    // "Close contact" so the dial surface becomes reachable.
    const closeContact = page.getByRole("button", { name: /close contact/i }).first();
    if ((await closeContact.count()) > 0 && (await closeContact.isVisible().catch(() => false))) {
      const disabled = await closeContact.isDisabled().catch(() => false);
      if (!disabled) {
        await closeContact.click({ force: true }).catch(() => undefined);
        await page.waitForTimeout(500);
        continue;
      }
    }

    await page.waitForTimeout(350);
  }

  await page.screenshot({ path: "test-results/connect-ccp-not-ready.png", fullPage: true }).catch(() => undefined);
  throw new Error(`Connect CCP did not become ready within ${timeoutMs / 1000}s. URL=${page.url()}`);
}

async function setAvailableStatusIfPrompted(page: Page): Promise<void> {
  const statusButton = page
    .getByRole("button", { name: /change status/i })
    .first();
  if ((await statusButton.count()) === 0) {
    return;
  }
  const visible = await statusButton.isVisible().catch(() => false);
  if (!visible) {
    return;
  }
  await statusButton.click({ force: true }).catch(() => undefined);
  await page.waitForTimeout(200);

  const availableOption = page
    .getByRole("option", { name: /^available$/i })
    .or(page.getByRole("menuitemradio", { name: /^available$/i }))
    .or(page.getByRole("button", { name: /^available$/i }))
    .first();
  if ((await availableOption.count()) === 0) {
    return;
  }
  await availableOption.click({ force: true }).catch(() => undefined);
  await page.waitForTimeout(350);
}

async function fillDialNumber(page: Page, rawNumber: string): Promise<void> {
  const normalized = normalizeDialNumber(rawNumber);
  const targetDigits = stripToDigits(normalized);
  await ensureOutboundDialSurface(page);
  await openNumberPadIfPresent(page);
  const inputCandidates = [
    page.getByRole("textbox", { name: /phone number|enter number|number/i }).first(),
    page.getByRole("textbox", { name: /phone number|number/i }).first(),
    page.locator("input[aria-label*='Phone' i], input[placeholder*='Phone' i], input[name*='phone' i]").first(),
    page.locator("input[type='tel']").first(),
    page.locator("[contenteditable='true'][aria-label*='Phone' i], [contenteditable='true'][placeholder*='Phone' i]").first(),
    page.locator("[contenteditable='true']").first(),
    page.locator("input").first()
  ];

  for (const input of inputCandidates) {
    if ((await input.count()) === 0) {
      continue;
    }
    const visible = await input.isVisible().catch(() => false);
    if (!visible) {
      continue;
    }
    await clearDialInput(input);
    await input.fill(normalized).catch(() => undefined);
    const value =
      (await input.inputValue().catch(() => "")) ||
      (await input.textContent().catch(() => "")) ||
      "";
    if (stripToDigits(value).includes(targetDigits)) {
      return;
    }
  }

  // Keyboard fallback for CCP variants where dial textbox is not writable via fill().
  await page.keyboard.press("Meta+A").catch(() => undefined);
  await page.keyboard.press("Control+A").catch(() => undefined);
  await page.keyboard.type(normalized, { delay: 25 }).catch(() => undefined);
  await page.waitForTimeout(150);
  const bodyAfterKeyboard = await page.locator("body").innerText().catch(() => "");
  if (hasDialedTargetNumber(bodyAfterKeyboard, targetDigits)) {
    return;
  }

  const typedByKeypad = await tryTypeNumberWithKeypad(page, normalized);
  if (typedByKeypad) {
    return;
  }

  // Last-resort: some CCP layouts preserve previous dial value. If target is already visible
  // and Call is enabled, allow the run to continue.
  const bodyText = await page.locator("body").innerText().catch(() => "");
  if (hasDialedTargetNumber(bodyText, targetDigits)) {
    const callReady = await hasEnabledCallButton(page);
    if (callReady) {
      return;
    }
  }

  throw new Error(`Unable to fill outbound number in Connect CCP dialer. URL=${page.url()}`);
}

async function clearDialInput(input: Locator): Promise<void> {
  await input.click({ force: true }).catch(() => undefined);
  await input.fill("").catch(() => undefined);
  const existing = await input.inputValue().catch(() => "");
  if (!existing) {
    return;
  }
  // Some CCP variants ignore fill(""); force clear with select-all/backspace.
  await input.press("Meta+A").catch(() => undefined);
  await input.press("Control+A").catch(() => undefined);
  await input.press("Backspace").catch(() => undefined);
}

async function ensureOutboundDialSurface(page: Page): Promise<void> {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    await dismissBlockingAlerts(page);
    await focusPhoneTab(page);

    const closeContact = page.getByRole("button", { name: /close contact/i }).first();
    if ((await closeContact.count()) > 0 && (await closeContact.isVisible().catch(() => false))) {
      const disabled = await closeContact.isDisabled().catch(() => false);
      if (!disabled) {
        await closeContact.click({ force: true }).catch(() => undefined);
        await page.waitForTimeout(350);
        continue;
      }
    }

    const endCall = page.getByRole("button", { name: /end call|hang up|disconnect/i }).first();
    if ((await endCall.count()) > 0 && (await endCall.isVisible().catch(() => false))) {
      const disabled = await endCall.isDisabled().catch(() => false);
      if (!disabled) {
        await endCall.click({ force: true }).catch(() => undefined);
        await page.waitForTimeout(350);
        continue;
      }
    }

    if (await hasReadyDialControls(page)) {
      return;
    }

    await page.waitForTimeout(300);
  }
  throw new Error(`Connect CCP did not reach outbound-dial-ready state. URL=${page.url()}`);
}

async function hasReadyDialControls(page: Page): Promise<boolean> {
  const inputCandidates = [
    page.getByRole("textbox", { name: /phone number|enter number|number/i }).first(),
    page.locator("input[aria-label*='Phone' i], input[placeholder*='Phone' i], input[name*='phone' i]").first(),
    page.locator("input[type='tel']").first()
  ];
  for (const input of inputCandidates) {
    if ((await input.count()) === 0) {
      continue;
    }
    const visible = await input.isVisible().catch(() => false);
    if (!visible) {
      continue;
    }
    const disabled = await input.isDisabled().catch(() => false);
    if (!disabled) {
      return true;
    }
  }

  const digitOne = await resolveDigitButton(page, "1");
  if (digitOne) {
    return true;
  }

  const numberPadButton = page.getByRole("button", { name: /number pad/i }).first();
  if ((await numberPadButton.count()) > 0 && (await numberPadButton.isVisible().catch(() => false))) {
    return true;
  }

  return false;
}

async function resolveEnabledCallButton(page: Page) {
  const candidates = [
    page.getByRole("button", { name: /^call$/i }).first(),
    page.getByRole("button", { name: /place call|dial/i }).first(),
    page.locator("button[title*='Call' i], button[aria-label*='Call' i]").first()
  ];
  for (const button of candidates) {
    if ((await button.count()) === 0) {
      continue;
    }
    const visible = await button.isVisible().catch(() => false);
    if (!visible) {
      continue;
    }
    const disabled = await button.isDisabled().catch(() => true);
    if (disabled) {
      continue;
    }
    return button;
  }
  throw new Error("No enabled Call button found in Connect CCP dialer.");
}

async function hasEnabledCallButton(page: Page): Promise<boolean> {
  try {
    await resolveEnabledCallButton(page);
    return true;
  } catch {
    return false;
  }
}

async function waitForDialStart(page: Page, timeoutMs: number, targetNumber: string): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  const targetDigits = stripToDigits(targetNumber);
  let lastSignal = "";
  while (Date.now() < deadline) {
    await dismissBlockingAlerts(page);
    const bodyRaw = await page.locator("body").innerText().catch(() => "");
    const body = bodyRaw.toLowerCase();
    if (body.includes("session expired")) {
      throw new Error("Connect CCP session expired while waiting for outbound dial transition.");
    }
    if (
      /invalid outbound configuration|must associate a phone number with this queue|before you can place an outbound call/i.test(
        bodyRaw
      )
    ) {
      throw new Error(
        "Connect CCP outbound dial is blocked: queue/routing profile is missing an associated outbound phone number."
      );
    }
    const endButton = page
      .getByRole("button", { name: /end call|hang up|disconnect/i })
      .or(page.locator("button[title*='End call' i], button[aria-label*='End call' i]").first())
      .first();
    const endVisible = (await endButton.count()) > 0 && (await endButton.isVisible().catch(() => false));
    const endEnabled = endVisible && !(await endButton.isDisabled().catch(() => false));
    const closeContact = page.getByRole("button", { name: /close contact/i }).first();
    const closeVisible =
      (await closeContact.count()) > 0 && (await closeContact.isVisible().catch(() => false));
    const closeEnabled = closeVisible && !(await closeContact.isDisabled().catch(() => false));
    const hasTimer = /\b\d{1,2}:\d{2}\b/.test(bodyRaw);
    const hasCallStateText = /calling|connecting|in call|call in progress|after call work/.test(body);
    const hasTargetNumber = hasDialedTargetNumber(bodyRaw, targetDigits);

    // Require stronger evidence that CCP actually opened an active outbound contact.
    if (endEnabled && (hasTimer || hasCallStateText || hasTargetNumber)) {
      await page
        .screenshot({ path: "test-results/connect-ccp-dial-started.png", fullPage: true })
        .catch(() => undefined);
      return Date.now();
    }
    if (hasTimer && (endVisible || closeVisible)) {
      await page
        .screenshot({ path: "test-results/connect-ccp-dial-started.png", fullPage: true })
        .catch(() => undefined);
      return Date.now();
    }
    if (hasCallStateText && hasTargetNumber && endVisible) {
      await page
        .screenshot({ path: "test-results/connect-ccp-dial-started.png", fullPage: true })
        .catch(() => undefined);
      return Date.now();
    }
    if (closeEnabled && hasTargetNumber && hasTimer) {
      await page
        .screenshot({ path: "test-results/connect-ccp-dial-started.png", fullPage: true })
        .catch(() => undefined);
      return Date.now();
    }

    lastSignal = JSON.stringify({
      endVisible,
      endEnabled,
      closeVisible,
      closeEnabled,
      hasTimer,
      hasCallStateText,
      hasTargetNumber
    });
    await page.waitForTimeout(300);
  }
  await page
    .screenshot({ path: "test-results/connect-ccp-dial-not-started.png", fullPage: true })
    .catch(() => undefined);
  throw new Error(`Connect CCP dial did not transition to an active outbound contact state. signal=${lastSignal}`);
}

async function endCallIfPresent(page: Page): Promise<void> {
  const candidates = [
    page.getByRole("button", { name: /end call|hang up|disconnect/i }).first(),
    page.locator("button[title*='End call' i], button[aria-label*='End call' i]").first(),
    page.locator("button[title*='Hang up' i], button[aria-label*='Hang up' i]").first()
  ];
  for (const button of candidates) {
    if ((await button.count()) === 0) {
      continue;
    }
    const visible = await button.isVisible().catch(() => false);
    if (!visible) {
      continue;
    }
    await button.click({ force: true }).catch(() => undefined);
    await page.waitForTimeout(250);
    return;
  }
}

function normalizeDialNumber(rawNumber: string): string {
  return rawNumber.trim().replace(/[^\d]/g, "");
}

function normalizeDtmfDigits(rawDigits: string): string {
  return rawDigits.replace(/[^0-9A-Da-d*#wW]/g, "");
}

function stripToDigits(value: string): string {
  return value.replace(/[^\d]/g, "");
}

function hasDialedTargetNumber(bodyText: string, targetDigits: string): boolean {
  if (targetDigits.length < 7) {
    return false;
  }

  const bodyDigits = stripToDigits(bodyText);
  if (!bodyDigits) {
    return false;
  }

  if (bodyDigits.includes(targetDigits)) {
    return true;
  }

  const trailing7 = targetDigits.slice(-7);
  const trailing10 = targetDigits.length >= 10 ? targetDigits.slice(-10) : "";
  if (trailing10 && bodyDigits.includes(trailing10)) {
    return true;
  }
  return bodyDigits.includes(trailing7);
}

async function openNumberPadIfPresent(page: Page): Promise<void> {
  const numberPadButton = page.getByRole("button", { name: /number pad/i }).first();
  if ((await numberPadButton.count()) === 0) {
    return;
  }
  const visible = await numberPadButton.isVisible().catch(() => false);
  if (!visible) {
    return;
  }
  await numberPadButton.click({ force: true }).catch(() => undefined);
  await page.waitForTimeout(200);
}

async function tryTypeNumberWithKeypad(page: Page, digitsOnly: string): Promise<boolean> {
  if (!digitsOnly) {
    return false;
  }
  await openNumberPadIfPresent(page);
  for (const digit of digitsOnly) {
    const button = await resolveDigitButton(page, digit);
    if (!button) {
      return false;
    }
    await button.click({ force: true }).catch(() => undefined);
    await page.waitForTimeout(40);
  }
  return true;
}

async function sendDtmfSequence(page: Page, digits: string, interDigitDelayMs: number): Promise<void> {
  if (!digits) {
    return;
  }

  const allowKeyboardFallback = process.env.CONNECT_CCP_DTMF_KEYBOARD_FALLBACK === "true";
  await openDtmfSurfaceIfPresent(page);
  for (const rawDigit of digits) {
    if (/w/i.test(rawDigit)) {
      await page.waitForTimeout(Math.max(300, interDigitDelayMs * 2));
      continue;
    }

    const digit = rawDigit.toUpperCase();
    await openDtmfSurfaceIfPresent(page);
    const button = await resolveDigitButton(page, digit);
    if (button) {
      await button.click({ force: true }).catch(() => undefined);
      await page.waitForTimeout(interDigitDelayMs);
      continue;
    }

    if (allowKeyboardFallback) {
      // Some CCP variants accept DTMF via keyboard even when keypad buttons are hidden.
      const typed = await trySendDtmfViaKeyboard(page, digit);
      if (typed) {
        await page.waitForTimeout(interDigitDelayMs);
        continue;
      }
    }

    throw new Error(
      `Unable to send DTMF digit "${digit}" using Connect CCP keypad. Set CONNECT_CCP_DTMF_KEYBOARD_FALLBACK=true to allow keyboard fallback.`
    );
  }
}

async function trySendDtmfViaKeyboard(page: Page, digit: string): Promise<boolean> {
  try {
    await page.keyboard.type(digit, { delay: 30 });
    return true;
  } catch {
    return false;
  }
}

async function openDtmfSurfaceIfPresent(page: Page): Promise<void> {
  const dtmfButtons = [
    page.getByRole("button", { name: /dtmf|keypad|dial pad|dialpad|number pad/i }).first(),
    page.getByRole("tab", { name: /dtmf|keypad|dial pad|dialpad|number pad/i }).first(),
    page.locator("button[aria-label*='keypad' i], button[title*='keypad' i]").first(),
    page.locator("button[aria-label*='dtmf' i], button[title*='dtmf' i]").first(),
    page.locator("button[aria-label*='dial pad' i], button[title*='dial pad' i]").first(),
    page
      .locator("button,div[role='button'],a[role='button'],div[role='tab']")
      .filter({ hasText: /dtmf|keypad|dial pad|dialpad|number pad/i })
      .first()
  ];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    for (const target of dtmfButtons) {
      if ((await target.count()) === 0) {
        continue;
      }
      if (!(await target.isVisible().catch(() => false))) {
        continue;
      }
      await target.click({ force: true }).catch(() => undefined);
      await page.waitForTimeout(220);
      if (await hasVisibleDtmfDigits(page)) {
        return;
      }
    }
    if (await hasVisibleDtmfDigits(page)) {
      return;
    }
    await page.waitForTimeout(220);
  }
}

async function waitForConnectedCallReadyForDtmf(page: Page, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const body = (await page.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ").trim();
    const hasConnected = /connected call|in call|after call work/i.test(body);
    const timerMatch = body.match(/\b(\d{1,2}):(\d{2})\b/);
    const timerReady =
      timerMatch !== null &&
      Number.parseInt(timerMatch[1], 10) >= 0 &&
      Number.parseInt(timerMatch[2], 10) >= 1;
    if (hasConnected && timerReady) {
      return;
    }
    await page.waitForTimeout(250);
  }
}

async function waitForCallElapsedAtLeast(
  page: Page,
  minElapsedSec: number,
  timeoutMs: number
): Promise<void> {
  if (minElapsedSec <= 0) {
    return;
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const body = (await page.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ").trim();
    const timerMatch = body.match(/\b(\d{1,2}):(\d{2})\b/);
    if (timerMatch) {
      const elapsed = Number.parseInt(timerMatch[1], 10) * 60 + Number.parseInt(timerMatch[2], 10);
      if (Number.isFinite(elapsed) && elapsed >= minElapsedSec) {
        return;
      }
    }
    await page.waitForTimeout(250);
  }
}

async function resolveDigitButton(page: Page, digit: string) {
  const normalizedDigit = digit.toUpperCase();
  const ariaAlias =
    normalizedDigit === "*"
      ? "(?:\\*|star)"
      : normalizedDigit === "#"
        ? "(?:#|pound|hash)"
        : escapeRegex(normalizedDigit);
  const candidates = [
    page.getByRole("button", { name: new RegExp(`^${ariaAlias}(?:\\s|$)`, "i") }).first(),
    page.getByRole("button", { name: new RegExp(ariaAlias, "i") }).first(),
    page.getByRole("link", { name: new RegExp(`^${ariaAlias}(?:\\s|$)`, "i") }).first(),
    page.getByRole("tab", { name: new RegExp(`^${ariaAlias}(?:\\s|$)`, "i") }).first(),
    page.locator("button").filter({ hasText: new RegExp(`^${ariaAlias}(?:\\s|$)`, "i") }).first(),
    page
      .locator("div[role='button'],a[role='button'],div,span")
      .filter({ hasText: new RegExp(`^${ariaAlias}(?:\\s|$)`, "i") })
      .first(),
    page.locator(`button[aria-label*='${normalizedDigit}' i]`).first(),
    page.locator(`button[title*='${normalizedDigit}' i]`).first(),
    page.locator(`[role='button'][aria-label*='${normalizedDigit}' i]`).first(),
    page.locator(`[role='button'][title*='${normalizedDigit}' i]`).first()
  ];
  for (const candidate of candidates) {
    if ((await candidate.count()) === 0) {
      continue;
    }
    const visible = await candidate.isVisible().catch(() => false);
    if (!visible) {
      continue;
    }
    const disabled = await candidate.isDisabled().catch(() => false);
    if (disabled) {
      continue;
    }
    return candidate;
  }
  return null;
}

async function hasVisibleDtmfDigits(page: Page): Promise<boolean> {
  const candidates = [
    page.getByRole("button", { name: /^1(?:\s|$)/i }).first(),
    page.getByRole("button", { name: /^2(?:\s|$)/i }).first(),
    page
      .locator("button,div[role='button'],a[role='button'],div,span")
      .filter({ hasText: /^\s*1(?:\s|$)/i })
      .first(),
    page
      .locator("button,div[role='button'],a[role='button'],div,span")
      .filter({ hasText: /^\s*2(?:\s|$)/i })
      .first()
  ];
  for (const candidate of candidates) {
    if ((await candidate.count()) > 0 && (await candidate.isVisible().catch(() => false))) {
      return true;
    }
  }
  return false;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function dismissBlockingAlerts(page: Page): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    const dismissButtons = page.getByRole("button", { name: /dismiss alert/i });
    const count = await dismissButtons.count().catch(() => 0);
    if (count === 0) {
      return;
    }
    const button = dismissButtons.first();
    const visible = await button.isVisible().catch(() => false);
    if (!visible) {
      return;
    }
    await button.click({ force: true }).catch(() => undefined);
    await page.waitForTimeout(120);
  }
}
