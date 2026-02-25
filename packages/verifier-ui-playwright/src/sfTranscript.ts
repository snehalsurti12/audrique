/**
 * sfTranscript.ts — Real-time transcript verification: widget detection,
 * text normalization, and phrase/growth assertions.
 *
 * Extracted from salesforce-voice.spec.ts (Phase A, Step 1).
 */

import type { Page } from "@playwright/test";
import { focusVoiceCallRecordSurface } from "./sfScreenPop";

// ── Types ────────────────────────────────────────────────────────────────────

export type TranscriptWidgetSnapshot = {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
  viewportWidth: number;
};

// ── Public API ──────────────────────────────────────────────────────────────

export async function verifyRealtimeTranscript(
  page: Page,
  args: {
    timeoutMs: number;
    expectedPhrase: string;
    minGrowthChars: number;
    requireRightSide: boolean;
  }
): Promise<{ x: number; y: number; w: number; h: number; phraseMatched: boolean; growth: number }> {
  await focusVoiceCallRecordSurface(page);
  const baseline = await waitForTranscriptWidget(page, args.timeoutMs);
  if (!baseline) {
    throw new Error("Transcript widget not found on VoiceCall page during active call.");
  }

  if (args.requireRightSide && baseline.x < baseline.viewportWidth * 0.45) {
    throw new Error(
      `Transcript widget detected but not on right side. x=${baseline.x}, viewportWidth=${baseline.viewportWidth}`
    );
  }

  const baselineBody = normalizeTranscriptText(baseline.text);
  const phrase = args.expectedPhrase.toLowerCase();
  const deadline = Date.now() + args.timeoutMs;
  while (Date.now() < deadline) {
    const current = await readTranscriptWidget(page);
    if (!current) {
      await page.waitForTimeout(1000);
      continue;
    }

    const currentBody = normalizeTranscriptText(current.text);
    const growth = Math.max(0, currentBody.length - baselineBody.length);
    const phraseMatched = phrase.length > 0 && currentBody.toLowerCase().includes(phrase);

    if (phraseMatched) {
      return { x: current.x, y: current.y, w: current.w, h: current.h, phraseMatched: true, growth };
    }

    if (phrase.length === 0 && growth >= args.minGrowthChars) {
      return { x: current.x, y: current.y, w: current.w, h: current.h, phraseMatched: false, growth };
    }

    await page.waitForTimeout(1000);
  }

  const current = await readTranscriptWidget(page);
  const finalText = normalizeTranscriptText(current?.text ?? "");
  if (phrase.length > 0) {
    throw new Error(
      `Transcript widget found, but expected phrase was not observed in real time: "${args.expectedPhrase}". Current text preview="${finalText.slice(
        0,
        220
      )}"`
    );
  }
  throw new Error(
    `Transcript widget found, but transcript text did not grow by at least ${args.minGrowthChars} chars. Final preview="${finalText.slice(
      0,
      220
    )}"`
  );
}

export async function waitForTranscriptWidget(
  page: Page,
  timeoutMs: number
): Promise<TranscriptWidgetSnapshot | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const widget = await readTranscriptWidget(page);
    if (widget) {
      return widget;
    }
    await page.waitForTimeout(600);
  }
  return null;
}

export async function readTranscriptWidget(page: Page): Promise<TranscriptWidgetSnapshot | null> {
  return page.evaluate(() => {
    const strongPattern = /call transcript|live transcript/i;
    const weakPattern = /\btranscript\b/i;
    const viewportWidth = window.innerWidth || 0;
    const nodes = Array.from(
      document.querySelectorAll(
        "aside, section, article, [role='region'], [role='complementary'], div"
      )
    );

    const candidates = [];
    for (const node of nodes) {
      const text = (node.textContent || "").replace(/\\s+/g, " ").trim();
      const strong = strongPattern.test(text);
      const weak = weakPattern.test(text);
      if (!strong && !weak) {
        continue;
      }
      const rect = node.getBoundingClientRect();
      if (rect.width < 140 || rect.height < 70) {
        continue;
      }
      if (rect.bottom < 0 || rect.top > window.innerHeight) {
        continue;
      }
      candidates.push({
        text,
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        w: Math.round(rect.width),
        h: Math.round(rect.height),
        score: Math.round(
          rect.x * 1000 +
            (strong ? 500000 : 0) -
            Math.min(300000, rect.width * rect.height)
        )
      });
    }

    if (candidates.length === 0) {
      return null;
    }
    candidates.sort((a, b) => b.score - a.score);
    const best = candidates[0];
    return {
      text: best.text,
      x: best.x,
      y: best.y,
      w: best.w,
      h: best.h,
      viewportWidth
    };
  });
}

export function normalizeTranscriptText(text: string): string {
  return text
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^(call transcript|live transcript|transcript|conversation)$/i.test(line))
    .join(" ");
}
