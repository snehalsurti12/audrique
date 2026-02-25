/**
 * sfOverlays.ts — Visual assertion overlay rendering: live assertion badges,
 * summary panels, and formatting utilities for in-video evidence.
 *
 * Extracted from salesforce-voice.spec.ts (Phase A, Step 1).
 */

import type { Page } from "@playwright/test";

// ── Types ────────────────────────────────────────────────────────────────────

export type VisualAssertionEntry = {
  label: string;
  passed: boolean;
  details: string;
  atIso: string;
};

// ── Public API ──────────────────────────────────────────────────────────────

export function formatAssertionDetails(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value && typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return "";
}

export async function pushVisualAssertion(
  page: Page,
  assertionLog: VisualAssertionEntry[],
  entry: Omit<VisualAssertionEntry, "atIso">
): Promise<void> {
  const record: VisualAssertionEntry = {
    ...entry,
    atIso: new Date().toISOString()
  };
  assertionLog.push(record);
  const statusPrefix = record.passed ? "✅" : "❌";
  const detailSuffix = record.details ? ` — ${record.details}` : "";
  console.log(`${statusPrefix} ${record.label}${detailSuffix}`);
  await renderAssertionOverlay(page, assertionLog).catch(() => undefined);
}

export async function renderAssertionOverlay(page: Page, assertionLog: VisualAssertionEntry[]): Promise<void> {
  const recent = assertionLog.slice(-6);
  await page.evaluate((items) => {
    const id = "__voice_assertion_overlay__";
    let root = document.getElementById(id);
    if (!root) {
      root = document.createElement("div");
      root.id = id;
      root.setAttribute(
        "style",
        [
          "position: fixed",
          "right: 12px",
          "top: 12px",
          "z-index: 2147483647",
          "max-width: 420px",
          "background: rgba(17, 24, 39, 0.94)",
          "border: 1px solid rgba(255,255,255,0.22)",
          "border-radius: 10px",
          "padding: 10px 12px",
          "box-shadow: 0 6px 18px rgba(0,0,0,0.45)",
          "font-family: Arial, sans-serif",
          "color: #f9fafb",
          "font-size: 13px",
          "line-height: 1.4"
        ].join(";")
      );
      document.body.appendChild(root);
    }

    const rows = items
      .map((item) => {
        const icon = item.passed ? "✅" : "❌";
        const details = item.details ? `: ${item.details}` : "";
        return `<div style="margin-top:6px;word-break:break-word;">${icon} ${escapeHtml(item.label)}${escapeHtml(
          details
        )}</div>`;
      })
      .join("");

    root.innerHTML = `
      <div style="font-weight:700;font-size:14px;">Live Assertions</div>
      ${rows || '<div style="margin-top:6px;opacity:.8;">Waiting for checkpoints...</div>'}
    `;

    function escapeHtml(value: unknown): string {
      return String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;");
    }
  }, recent);
}

export async function renderAssertionSummary(
  page: Page,
  assertionLog: VisualAssertionEntry[],
  requiredAssertions: readonly string[],
  displayMs: number
): Promise<void> {
  const statusByLabel = new Map<string, VisualAssertionEntry>();
  for (const entry of assertionLog) {
    statusByLabel.set(entry.label, entry);
  }
  const items = requiredAssertions.map((label) => {
    const value = statusByLabel.get(label);
    if (!value) {
      return { label, status: "pending", details: "Not executed" };
    }
    return {
      label,
      status: value.passed ? "passed" : "failed",
      details: value.details || ""
    };
  });
  const failed = items.some((item) => item.status === "failed");
  const pending = items.some((item) => item.status === "pending");
  const overall = failed ? "FAIL" : pending ? "PARTIAL" : "PASS";

  await page.evaluate(
    ({ summaryItems, overallStatus }) => {
      const id = "__voice_assertion_summary__";
      let root = document.getElementById(id);
      if (!root) {
        root = document.createElement("div");
        root.id = id;
        root.setAttribute(
          "style",
          [
            "position: fixed",
            "left: 50%",
            "top: 16px",
            "transform: translateX(-50%)",
            "z-index: 2147483647",
            "min-width: 640px",
            "max-width: 90vw",
            "background: rgba(3, 7, 18, 0.95)",
            "border: 2px solid rgba(255,255,255,0.32)",
            "border-radius: 12px",
            "padding: 14px 18px",
            "box-shadow: 0 8px 24px rgba(0,0,0,0.55)",
            "font-family: Arial, sans-serif",
            "color: #f9fafb"
          ].join(";")
        );
        document.body.appendChild(root);
      }

      const badgeColor =
        overallStatus === "PASS" ? "#10b981" : overallStatus === "FAIL" ? "#ef4444" : "#f59e0b";
      const listHtml = summaryItems
        .map((item) => {
          const icon = item.status === "passed" ? "✅" : item.status === "failed" ? "❌" : "⏳";
          const details = item.details ? ` — ${escapeHtml(item.details)}` : "";
          return `<div style="margin-top:6px;font-size:14px;">${icon} ${escapeHtml(item.label)}${details}</div>`;
        })
        .join("");

      root.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <div style="font-size:16px;font-weight:700;">E2E Assertion Summary</div>
          <div style="font-size:13px;font-weight:700;padding:3px 8px;border-radius:8px;background:${badgeColor};color:#0b1020;">${overallStatus}</div>
        </div>
        <div style="margin-top:8px;">${listHtml}</div>
      `;

      function escapeHtml(value: unknown): string {
        return String(value)
          .replaceAll("&", "&amp;")
          .replaceAll("<", "&lt;")
          .replaceAll(">", "&gt;");
      }
    },
    { summaryItems: items, overallStatus: overall }
  );

  await page.waitForTimeout(displayMs);
}
