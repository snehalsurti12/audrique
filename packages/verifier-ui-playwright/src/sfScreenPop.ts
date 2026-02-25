/**
 * sfScreenPop.ts — VoiceCall screen pop detection, tab focusing,
 * and record field reading.
 *
 * Extracted from salesforce-voice.spec.ts (Phase A, Step 1).
 */

import type { Page } from "@playwright/test";
import { voiceCallTabs, hasConnectedCallUiIndicator } from "./sfCallDetection";

// ── VoiceCall tab focus ──────────────────────────────────────────────────────

export async function focusLatestVoiceCallTab(page: Page, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const vcTabs = voiceCallTabs(page);
    const count = await vcTabs.count();
    if (count > 0) {
      let targetIndex = count - 1;
      let bestVcNumber = -1;
      for (let i = 0; i < count; i += 1) {
        const text = ((await vcTabs.nth(i).innerText().catch(() => "")) ?? "").trim();
        const match = text.match(/VC-(\d+)/i);
        if (!match) {
          continue;
        }
        const vcNumber = Number(match[1]);
        if (Number.isFinite(vcNumber) && vcNumber >= bestVcNumber) {
          bestVcNumber = vcNumber;
          targetIndex = i;
        }
      }

      await vcTabs.nth(targetIndex).click({ force: true }).catch(() => undefined);
      await page.waitForTimeout(300);

      const onObjectLinkingSurface = await page
        .getByText(/channel-object linking/i)
        .first()
        .isVisible()
        .catch(() => false);
      if (!onObjectLinkingSurface || (await hasConnectedCallUiIndicator(page))) {
        return true;
      }
    }

    await page.waitForTimeout(350);
  }
  return false;
}

export async function focusVoiceCallRecordSurface(page: Page): Promise<void> {
  await focusLatestVoiceCallTab(page, 6_000);
}

// ── VoiceCall record reading ─────────────────────────────────────────────────

export async function readVoiceCallRecordSnapshot(
  page: Page,
  timeoutMs: number
): Promise<{ id: string; callType: string; owner: string }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await focusLatestVoiceCallTab(page, 2_000);
    const id = await getActiveVoiceCallId(page);
    const callType = await readFieldValueByLabel(page, /call type/i);
    const owner = await readFieldValueByLabel(page, /^owner$/i);
    if (id) {
      return { id, callType, owner };
    }
    await page.waitForTimeout(500);
  }
  throw new Error("Could not detect active VoiceCall record details on screen.");
}

export async function getActiveVoiceCallId(page: Page): Promise<string> {
  const tabTexts = await voiceCallTabs(page).allInnerTexts().catch(() => []);
  for (const text of tabTexts.reverse()) {
    const match = text.match(/VC-\d+/i);
    if (match) {
      return match[0].toUpperCase();
    }
  }
  const bodyText = await page.locator("body").innerText().catch(() => "");
  const bodyMatch = bodyText.match(/VC-\d+/i);
  return bodyMatch ? bodyMatch[0].toUpperCase() : "";
}

// ── Field value reading ──────────────────────────────────────────────────────

export async function waitForFieldValueByLabel(
  page: Page,
  labelPattern: RegExp,
  timeoutMs: number
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await readFieldValueByLabel(page, labelPattern);
    if (value) {
      return value;
    }
    await page.waitForTimeout(400);
  }
  throw new Error(`Field value not found for label pattern ${labelPattern}`);
}

export async function readFieldValueByLabel(page: Page, labelPattern: RegExp): Promise<string> {
  const bodyText = await page.locator("body").innerText().catch(() => "");
  const lines = bodyText
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const noise = /^(details|feed|actions|loading|click to dial|refresh this feed|add favorite|favorites list|guidance center|salesforce help|setup|notifications|show menu|search|inbox|phone|connection status|new case|to do list|history|notes|macros|new grower)$/i;
  const likelyDecorative = /^(\u2705|\u274C|\u23F3)\s+/;

  for (let i = 0; i < lines.length; i += 1) {
    if (!labelPattern.test(lines[i])) {
      continue;
    }
    for (let j = i + 1; j < Math.min(lines.length, i + 8); j += 1) {
      const candidate = lines[j];
      if (!candidate || labelPattern.test(candidate)) {
        continue;
      }
      if (noise.test(candidate) || likelyDecorative.test(candidate)) {
        continue;
      }
      if (/^(edit|help)\b/i.test(candidate)) {
        continue;
      }
      return candidate;
    }
  }

  return "";
}
