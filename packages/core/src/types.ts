export type StepAction = "dial" | "send_dtmf" | "wait" | "hangup";

export type AssertionType =
  | "connect.flow_path"
  | "connect.agent_offer"
  | "connect.disconnect_reason"
  | "sf.attendance.voicecall_created"
  | "sf.attendance.agentwork_created"
  | "sf.attendance.offer_state"
  | "sf.attendance.case_created"
  | "sf.attendance.voicecall_linked_case"
  | "sf.attendance.contact_match"
  | "sf.ui.incoming_toast_visible"
  | "sf.ui.accept_button_visible"
  | "sf.ui.call_panel_active"
  | "sf.ui.screen_pop_record_type"
  | "sf.ui.wrapup_visible"
  | "sf.ui.required_disposition_enforced";

export interface ScenarioStep {
  action: StepAction;
  value?: string;
  seconds?: number;
}

export interface ScenarioAssertion {
  type: AssertionType;
  equals: string | boolean;
  fields?: Record<string, unknown>;
  queueDeveloperName?: string;
  agentUsername?: string;
}

export interface Scenario {
  id: string;
  description?: string;
  entryPoint: string;
  caller: {
    phone: string;
    contactExists: boolean;
    attributes?: Record<string, string>;
  };
  steps: ScenarioStep[];
  expect: ScenarioAssertion[];
  timeouts: {
    agent_offer_sec: number;
    record_creation_sec: number;
    ui_render_sec: number;
  };
}

export interface Evidence {
  assertionKey: AssertionType;
  pass: boolean;
  observed: unknown;
  expected: unknown;
  source: "salesforce" | "connect" | "ui";
  refs?: Record<string, string>;
}

export interface CallProvider {
  placeCall(input: {
    to: string;
    from: string;
    metadata: Record<string, string>;
  }): Promise<{ callId: string }>;
  sendDtmf(input: { callId: string; digits: string }): Promise<void>;
  hangup(input: { callId: string }): Promise<void>;
}

export interface ConnectVerifier {
  verify(assertion: ScenarioAssertion, context: RunContext): Promise<Evidence>;
}

export interface SalesforceVerifier {
  verify(assertion: ScenarioAssertion, context: RunContext): Promise<Evidence>;
}

export interface UiVerifier {
  verify(assertion: ScenarioAssertion, context: RunContext): Promise<Evidence>;
}

export interface RunContext {
  testRunId: string;
  scenarioId: string;
  entryPoint: string;
  callId?: string;
  timeoutSec: number;
}

export interface RunResult {
  scenarioId: string;
  testRunId: string;
  passed: boolean;
  evidence: Evidence[];
}
