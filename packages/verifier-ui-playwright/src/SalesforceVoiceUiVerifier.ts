import { expect, Page } from "@playwright/test";
import { Evidence, RunContext, ScenarioAssertion, UiVerifier } from "../../core/src/types";

export interface SalesforceUiSelectors {
  incomingToast: string;
  acceptButton: string;
  activeCallPanel: string;
  wrapupPanel: string;
  dispositionRequiredError: string;
  screenPopHeader: string;
}

const defaultSelectors: SalesforceUiSelectors = {
  incomingToast: '[data-testid="voice-incoming-toast"]',
  acceptButton: '[data-testid="voice-accept"]',
  activeCallPanel: '[data-testid="voice-active-panel"]',
  wrapupPanel: '[data-testid="voice-wrapup-panel"]',
  dispositionRequiredError: '[data-testid="voice-disposition-required"]',
  screenPopHeader: '[data-testid="screen-pop-header"]'
};

export class SalesforceVoiceUiVerifier implements UiVerifier {
  constructor(
    private readonly page: Page,
    private readonly selectors: SalesforceUiSelectors = defaultSelectors
  ) {}

  async verify(assertion: ScenarioAssertion, context: RunContext): Promise<Evidence> {
    const timeoutMs = context.timeoutSec * 1000;
    switch (assertion.type) {
      case "sf.ui.incoming_toast_visible":
        return this.visibleAssertion(assertion, this.selectors.incomingToast, timeoutMs, "ui");
      case "sf.ui.accept_button_visible":
        return this.visibleAssertion(assertion, this.selectors.acceptButton, timeoutMs, "ui");
      case "sf.ui.call_panel_active":
        return this.visibleAssertion(assertion, this.selectors.activeCallPanel, timeoutMs, "ui");
      case "sf.ui.wrapup_visible":
        return this.visibleAssertion(assertion, this.selectors.wrapupPanel, timeoutMs, "ui");
      case "sf.ui.required_disposition_enforced":
        return this.visibleAssertion(assertion, this.selectors.dispositionRequiredError, timeoutMs, "ui");
      case "sf.ui.screen_pop_record_type":
        return this.screenPopTypeAssertion(assertion, timeoutMs);
      default:
        throw new Error(`Unsupported UI assertion: ${assertion.type}`);
    }
  }

  private async visibleAssertion(
    assertion: ScenarioAssertion,
    selector: string,
    timeoutMs: number,
    source: "ui"
  ): Promise<Evidence> {
    const locator = this.page.locator(selector).first();
    let observed = false;
    try {
      await expect(locator).toBeVisible({ timeout: timeoutMs });
      observed = true;
    } catch {
      observed = false;
    }
    return {
      assertionKey: assertion.type,
      pass: observed === assertion.equals,
      observed,
      expected: assertion.equals,
      source
    };
  }

  private async screenPopTypeAssertion(assertion: ScenarioAssertion, timeoutMs: number): Promise<Evidence> {
    const locator = this.page.locator(this.selectors.screenPopHeader).first();
    let observed = "Unknown";
    try {
      await expect(locator).toBeVisible({ timeout: timeoutMs });
      const text = (await locator.textContent()) ?? "";
      observed = parseScreenPopType(text);
    } catch {
      observed = "Unknown";
    }
    return {
      assertionKey: assertion.type,
      pass: observed === assertion.equals,
      observed,
      expected: assertion.equals,
      source: "ui"
    };
  }
}

function parseScreenPopType(text: string): "Case" | "Contact" | "Account" | "Lead" | "Unknown" {
  const normalized = text.toLowerCase();
  if (normalized.includes("case")) {
    return "Case";
  }
  if (normalized.includes("contact")) {
    return "Contact";
  }
  if (normalized.includes("account")) {
    return "Account";
  }
  if (normalized.includes("lead")) {
    return "Lead";
  }
  return "Unknown";
}
