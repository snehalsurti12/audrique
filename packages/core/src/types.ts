export type StepAction =
  | "dial"
  | "send_dtmf"
  | "send_dtmf_sequence"
  | "wait"
  | "wait_for_ivr_prompt"
  | "hangup"
  // Call lifecycle
  | "hold_call"
  | "resume_call"
  | "end_call"
  // Audio injection
  | "play_agent_audio"
  | "play_caller_audio"
  | "inject_audio"
  // Verification
  | "verify_screen_pop"
  | "verify_voicecall_record"
  | "wait_for_transcript"
  | "verify_prompt_played"
  | "verify_no_agent_offer"
  // After-call work
  | "complete_acw"
  // Orchestration (used by E2E suite runner)
  | "preflight"
  | "trigger_call"
  | "detect_incoming"
  | "accept_call"
  | "decline_call"
  | "start_supervisor"
  // Business hours / voicemail / callback
  | "wait_for_disconnect"
  | "wait_for_voicemail_prompt"
  | "leave_voicemail"
  | "request_callback"
  | "verify_callback_created"
  | "verify_voicemail_created"
  | "verify_business_hours_routing"
  | "listen_for_prompt";

export type AssertionType =
  // Connect assertions
  | "connect.flow_path"
  | "connect.agent_offer"
  | "connect.disconnect_reason"
  // Salesforce record assertions
  | "sf.attendance.voicecall_created"
  | "sf.attendance.agentwork_created"
  | "sf.attendance.offer_state"
  | "sf.attendance.case_created"
  | "sf.attendance.voicecall_linked_case"
  | "sf.attendance.contact_match"
  // VoiceCall field assertions
  | "sf.attendance.voicecall_call_type"
  | "sf.attendance.voicecall_duration_gte"
  | "sf.attendance.voicecall_disposition"
  | "sf.attendance.voicecall_owner"
  // AgentWork state assertions
  | "sf.attendance.agentwork_status"
  | "sf.attendance.agentwork_routing_type"
  | "sf.attendance.agentwork_channel"
  // PendingServiceRouting assertions
  | "sf.attendance.psr_created"
  | "sf.attendance.psr_routing_type"
  | "sf.attendance.psr_queue"
  | "sf.attendance.psr_skill"
  | "sf.attendance.psr_capacity_weight"
  | "sf.attendance.psr_is_transfer"
  // UI assertions
  | "sf.ui.incoming_toast_visible"
  | "sf.ui.accept_button_visible"
  | "sf.ui.call_panel_active"
  | "sf.ui.screen_pop_record_type"
  | "sf.ui.wrapup_visible"
  | "sf.ui.required_disposition_enforced"
  // E2E assertions (used by suite runner)
  | "e2e.call_connected"
  | "e2e.screen_pop_detected"
  | "e2e.supervisor_queue_observed"
  | "e2e.supervisor_agent_offer"
  | "e2e.transcript_captured"
  | "e2e.hold_resume_completed"
  | "e2e.acw_completed"
  | "e2e.call_duration_sec"
  | "e2e.routing_type"
  | "e2e.skill_matched"
  // Business hours / voicemail / callback assertions
  | "e2e.call_disconnected_by_system"
  | "e2e.prompt_played"
  | "e2e.voicemail_recorded"
  | "e2e.callback_task_created"
  | "e2e.no_agent_offer"
  | "e2e.business_hours_routed"
  // Salesforce record assertions for voicemail / callback
  | "sf.attendance.voicemail_created"
  | "sf.attendance.voicemail_transcript"
  | "sf.attendance.voicemail_duration_gte"
  | "sf.attendance.voicemail_assigned_queue"
  | "sf.attendance.callback_task_created"
  | "sf.attendance.callback_task_status"
  | "sf.attendance.callback_task_queue"
  // Connect flow assertions
  | "connect.prompt_played"
  | "connect.business_hours_check"
  | "connect.queue_overflow_triggered"
  | "connect.voicemail_flow_entered"
  | "connect.callback_flow_entered";

/** Routing type for how a call reaches an agent. */
export type RoutingType = "queue" | "skill" | "direct_agent" | "extension";

export interface ScenarioStep {
  action: StepAction;
  value?: string;
  seconds?: number;
  // Extended fields for declarative scenarios
  digits?: string;
  text?: string;
  voice?: string;
  delayBeforeMs?: number;
  durationMs?: number;
  timeoutSec?: number;
  queue?: string;
  surface?: string;
  skill?: string;
  skillLevel?: number;
  observeAgentOffer?: boolean;
  checkBeforeAccept?: boolean;
  contains?: string;
  disposition?: string;
  notes?: string;
  // Business hours
  expectedRoute?: "open" | "closed" | "holiday" | "overflow";
  // Prompt / audio verification
  promptId?: string;
  promptText?: string;
  /** Max seconds to wait for audio/prompt detection. */
  listenTimeoutSec?: number;
  // Voicemail
  voicemailText?: string;
  voicemailDurationSec?: number;
  // Callback
  callbackPhone?: string;
  callbackTimeframe?: string;
  // Decline / no-answer
  declineReason?: "busy" | "timeout" | "manual";
  label?: string;
}

export interface ScenarioAssertion {
  type: AssertionType;
  equals?: string | boolean | number;
  fields?: Record<string, unknown>;
  queue?: string;
  queueDeveloperName?: string;
  agentUsername?: string;
  skill?: string;
  contains?: string;
  gte?: number;
}

/** Call trigger configuration — how the inbound call is placed. */
export interface CallTrigger {
  mode: "connect_ccp" | "twilio" | "manual";
  /** Routing type for this call. */
  routingType?: RoutingType;
  /** DTMF digits for single-level IVR (legacy). */
  ivrDigits?: string;
  /** Multi-level DTMF sequences (modern). */
  ivrSequence?: Array<{
    digits: string;
    label?: string;
    delayBeforeMs?: number;
  }>;
  /** Entry point phone number (overrides profile default). */
  entryNumber?: string;
  /** For direct-agent routing: target agent. */
  targetAgent?: string;
  /** For extension-based routing: extension number. */
  extension?: string;
  /** For skill-based routing: required skills. */
  requiredSkills?: Array<{
    name: string;
    minLevel?: number;
  }>;
  // IVR timing
  ivrInitialDelayMs?: number;
  ivrInterDigitDelayMs?: number;
  ivrPostDelayMs?: number;
  dtmfMinCallElapsedSec?: number;
  /** Call timing context for business hours testing. */
  callTiming?: {
    /** When to place the call: "during_hours", "after_hours", "holiday", "now" (default). */
    window: "during_hours" | "after_hours" | "holiday" | "now";
    /** Specific time override (ISO 8601). If set, call is placed at this time. */
    scheduledAt?: string;
  };
  /** Expected call outcome when no agent is available. */
  noAgentBehavior?: "voicemail" | "callback" | "disconnect" | "overflow_queue" | "prompt_and_disconnect";
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

/**
 * E2E Scenario — declarative format used by the suite runner.
 * Extends Scenario with callTrigger and routing configuration.
 */
export interface E2eScenario {
  id: string;
  description?: string;
  /** Allow this scenario to fail without failing the suite. */
  allowFailure?: boolean;
  /** How the inbound call is placed + routed. */
  callTrigger: CallTrigger;
  /** Ordered steps the scenario interpreter executes. */
  steps: ScenarioStep[];
  /** Assertions evaluated after all steps complete. */
  expect: ScenarioAssertion[];
  /** Timeout overrides for this scenario. */
  timeouts?: {
    ringSec?: number;
    supervisorQueueSec?: number;
    supervisorAgentOfferSec?: number;
    offerAfterQueueSec?: number;
    supervisorPostQueueHoldSec?: number;
  };
}

/**
 * E2E Suite — a collection of declarative scenarios.
 */
export interface E2eSuite {
  name: string;
  version?: number;
  stopOnFailure?: boolean;
  defaults?: {
    callTrigger?: Partial<CallTrigger>;
    timeouts?: E2eScenario["timeouts"];
  };
  scenarios: E2eScenario[];
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
