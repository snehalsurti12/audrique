/**
 * scenario-bridge.mjs — Converts declarative v2 scenario format to env-var
 * overrides that the existing salesforce-voice.spec.ts understands.
 *
 * This is the bridge layer: clean authoring format on top, existing spec
 * execution underneath. No spec changes required.
 *
 * Usage (from suite runner):
 *   import { isDeclarativeSuite, scenarioToEnv } from "./scenario-bridge.mjs";
 *   if (isDeclarativeSuite(suite)) {
 *     const env = scenarioToEnv(scenario, suite.defaults);
 *   }
 */

/**
 * Detect whether a suite file uses the declarative v2 format.
 * v2 suites have `version: 2` and scenarios with `steps[]`.
 */
export function isDeclarativeSuite(suite) {
  if (suite?.version === 2) return true;
  const first = suite?.scenarios?.[0];
  return first && Array.isArray(first.steps);
}

/**
 * Convert a single declarative scenario + suite defaults into the flat
 * env-var map that salesforce-voice.spec.ts reads via process.env.
 *
 * @param {object} scenario - Declarative scenario object
 * @param {object} defaults - Suite-level defaults (callTrigger, timeouts)
 * @returns {object} Flat key-value env overrides
 */
export function scenarioToEnv(scenario, defaults = {}) {
  const env = {};
  const steps = scenario.steps ?? [];
  const callTrigger = { ...defaults?.callTrigger, ...scenario.callTrigger };
  const timeouts = { ...defaults?.timeouts, ...scenario.timeouts };

  // ── Call trigger ──────────────────────────────────────────────────────
  env.CALL_TRIGGER_MODE = callTrigger.mode ?? "connect_ccp";
  env.CALL_EXPECTATION = "agent_offer";

  // Routing type (queue, skill, direct_agent, extension)
  if (callTrigger.routingType) {
    env.ROUTING_TYPE = callTrigger.routingType;
  }
  if (callTrigger.targetAgent) {
    env.DIRECT_AGENT_TARGET = callTrigger.targetAgent;
  }
  if (callTrigger.extension) {
    env.EXTENSION_NUMBER = callTrigger.extension;
  }
  // Skill-based routing
  if (callTrigger.requiredSkills?.length > 0) {
    env.REQUIRED_SKILLS = JSON.stringify(callTrigger.requiredSkills);
  }
  // Multi-level IVR sequence
  if (callTrigger.ivrSequence?.length > 0) {
    env.IVR_SEQUENCE = JSON.stringify(callTrigger.ivrSequence);
  }

  if (callTrigger.entryNumber) {
    env.CONNECT_ENTRYPOINT_NUMBER = callTrigger.entryNumber;
  }
  if (callTrigger.ivrDigits != null) {
    env.CONNECT_CCP_IVR_DIGITS = String(callTrigger.ivrDigits);
  }
  if (callTrigger.ivrInitialDelayMs != null) {
    env.CONNECT_CCP_IVR_INITIAL_DELAY_MS = String(callTrigger.ivrInitialDelayMs);
  }
  if (callTrigger.ivrInterDigitDelayMs != null) {
    env.CONNECT_CCP_IVR_INTER_DIGIT_DELAY_MS = String(callTrigger.ivrInterDigitDelayMs);
  }
  if (callTrigger.ivrPostDelayMs != null) {
    env.CONNECT_CCP_IVR_POST_DELAY_MS = String(callTrigger.ivrPostDelayMs);
  }
  if (callTrigger.dtmfMinCallElapsedSec != null) {
    env.CONNECT_CCP_DTMF_MIN_CALL_ELAPSED_SEC = String(callTrigger.dtmfMinCallElapsedSec);
  }

  // ── Timeouts ─────────────────────────────────────────────────────────
  if (timeouts.ringSec != null) {
    env.VOICE_RING_TIMEOUT_SEC = String(timeouts.ringSec);
  }
  if (timeouts.supervisorQueueSec != null) {
    env.SUPERVISOR_QUEUE_WAIT_TIMEOUT_SEC = String(timeouts.supervisorQueueSec);
  }
  if (timeouts.supervisorAgentOfferSec != null) {
    env.SUPERVISOR_AGENT_OFFER_TIMEOUT_SEC = String(timeouts.supervisorAgentOfferSec);
  }
  if (timeouts.offerAfterQueueSec != null) {
    env.OFFER_AFTER_QUEUE_TIMEOUT_SEC = String(timeouts.offerAfterQueueSec);
  }
  if (timeouts.supervisorPostQueueHoldSec != null) {
    env.SUPERVISOR_POST_QUEUE_HOLD_SEC = String(timeouts.supervisorPostQueueHoldSec);
  }

  // ── Step-driven flags ────────────────────────────────────────────────
  // Default supervisor off; individual steps turn it on.
  env.VERIFY_SUPERVISOR_QUEUE_WAITING = "false";
  env.VERIFY_SUPERVISOR_AGENT_OFFER = "false";

  for (const step of steps) {
    switch (step.action) {
      case "preflight":
        // No special env needed — spec always runs preflight.
        break;

      case "trigger_call":
        // Already handled by callTrigger above.
        break;

      case "detect_incoming": {
        // Override ring timeout from step if specified.
        if (step.timeoutSec != null) {
          env.VOICE_RING_TIMEOUT_SEC = String(step.timeoutSec);
        }
        break;
      }

      case "accept_call":
        // Default behavior — spec always attempts accept after detection.
        break;

      case "verify_screen_pop":
        // Default behavior — spec always checks screen pop after accept.
        break;

      case "start_supervisor": {
        env.VERIFY_SUPERVISOR_QUEUE_WAITING = "true";
        if (step.queue) {
          env.SUPERVISOR_QUEUE_NAME = step.queue;
        }
        if (step.surface) {
          env.SUPERVISOR_SURFACE_NAME = step.surface;
        }
        if (step.agentName) {
          env.SUPERVISOR_AGENT_NAME = step.agentName;
        }
        if (step.skill) {
          env.SUPERVISOR_SKILL_FILTER = step.skill;
        }
        if (step.skillLevel != null) {
          env.SUPERVISOR_SKILL_MIN_LEVEL = String(step.skillLevel);
        }
        if (step.observeAgentOffer === true) {
          env.VERIFY_SUPERVISOR_AGENT_OFFER = "true";
        }
        if (step.checkBeforeAccept === true) {
          env.SUPERVISOR_CHECK_BEFORE_ACCEPT = "true";
        }
        // Robust supervisor defaults for declarative mode.
        env.SUPERVISOR_REQUIRE_PRE_ACCEPT_OBSERVATION = "false";
        env.SUPERVISOR_ALLOW_IN_PROGRESS_FALLBACK = "true";
        env.SUPERVISOR_SKIP_QUEUE_BACKLOG = "false";
        env.SUPERVISOR_REQUIRE_TABLE_SOURCE = "true";
        env.SUPERVISOR_REQUIRE_TOTAL_WAITING_HEADER = "true";
        env.ALLOW_DELTA_SIGNALS_IN_SUPERVISOR = "true";
        break;
      }

      case "send_dtmf_sequence": {
        // Multi-level IVR: send digits at a specific step (not all-at-once)
        if (step.digits) {
          env[`DTMF_LEVEL_${steps.indexOf(step)}_DIGITS`] = step.digits;
        }
        if (step.delayBeforeMs != null) {
          env[`DTMF_LEVEL_${steps.indexOf(step)}_DELAY_MS`] = String(step.delayBeforeMs);
        }
        break;
      }

      case "wait_for_ivr_prompt": {
        if (step.timeoutSec != null) {
          env[`IVR_PROMPT_WAIT_${steps.indexOf(step)}_SEC`] = String(step.timeoutSec);
        }
        break;
      }

      case "verify_voicecall_record":
        // Future: enables post-accept record field assertions.
        break;

      case "verify_transcript": {
        env.VERIFY_REALTIME_TRANSCRIPT = "true";
        if (step.expectPhrase) {
          env.TRANSCRIPT_EXPECT_PHRASE = step.expectPhrase;
        }
        if (step.timeoutSec != null) {
          env.TRANSCRIPT_WAIT_SEC = String(step.timeoutSec);
        }
        break;
      }

      // ── Conversation steps ───────────────────────────────────────────
      case "play_agent_audio": {
        env.PLAY_AGENT_AUDIO = "true";
        if (step.text) env.AGENT_SPEECH_TEXT = step.text;
        if (step.voice) env.AGENT_SPEECH_VOICE = step.voice;
        if (step.durationMs != null) env.AGENT_SPEECH_DURATION_MS = String(step.durationMs);
        break;
      }

      case "play_caller_audio": {
        env.PLAY_CALLER_AUDIO = "true";
        if (step.text) env.CALLER_SPEECH_TEXT = step.text;
        if (step.voice) env.CALLER_SPEECH_VOICE = step.voice;
        if (step.durationMs != null) env.CALLER_SPEECH_DURATION_MS = String(step.durationMs);
        break;
      }

      case "wait_for_transcript": {
        env.VERIFY_CONVERSATION_TRANSCRIPT = "true";
        if (step.contains) env.CONVERSATION_TRANSCRIPT_PHRASE = step.contains;
        if (step.timeoutSec != null) env.CONVERSATION_TRANSCRIPT_WAIT_SEC = String(step.timeoutSec);
        break;
      }

      case "hold_call":
        env.TEST_HOLD_RESUME = "true";
        break;

      case "resume_call":
        // Paired with hold_call — flag already set.
        break;

      case "wait": {
        if (step.seconds != null) env.HOLD_DURATION_SEC = String(step.seconds);
        break;
      }

      case "end_call":
        env.AGENT_ENDS_CALL = "true";
        break;

      case "complete_acw": {
        env.COMPLETE_ACW = "true";
        if (step.disposition) env.ACW_DISPOSITION = step.disposition;
        if (step.notes) env.ACW_NOTES = step.notes;
        break;
      }

      case "decline_call": {
        env.CALL_EXPECTATION = "decline";
        if (step.declineReason) env.DECLINE_REASON = step.declineReason;
        break;
      }

      // ── Business hours / voicemail / callback steps ──────────────────
      case "listen_for_prompt": {
        env.LISTEN_FOR_PROMPT = "true";
        if (step.promptText) {
          // Accumulate prompt texts for multi-prompt scenarios
          const key = `EXPECTED_PROMPT_${steps.filter((s) => s.action === "listen_for_prompt").indexOf(step)}`;
          env[key] = step.promptText;
        }
        if (step.listenTimeoutSec != null) env.PROMPT_LISTEN_TIMEOUT_SEC = String(step.listenTimeoutSec);
        break;
      }

      case "wait_for_disconnect": {
        env.EXPECT_SYSTEM_DISCONNECT = "true";
        if (step.timeoutSec != null) env.DISCONNECT_TIMEOUT_SEC = String(step.timeoutSec);
        break;
      }

      case "leave_voicemail": {
        env.LEAVE_VOICEMAIL = "true";
        if (step.voicemailText) env.VOICEMAIL_TEXT = step.voicemailText;
        if (step.voicemailDurationSec != null) env.VOICEMAIL_DURATION_SEC = String(step.voicemailDurationSec);
        break;
      }

      case "request_callback": {
        env.REQUEST_CALLBACK = "true";
        if (step.digits) env.CALLBACK_DTMF = step.digits;
        if (step.callbackPhone) env.CALLBACK_PHONE = step.callbackPhone;
        break;
      }

      case "verify_callback_created":
        env.VERIFY_CALLBACK_TASK = "true";
        break;

      case "verify_voicemail_created":
        env.VERIFY_VOICEMAIL_RECORD = "true";
        break;

      case "verify_business_hours_routing":
        env.VERIFY_BUSINESS_HOURS = "true";
        break;

      case "verify_prompt_played":
        env.VERIFY_PROMPT_PLAYED = "true";
        break;

      case "verify_no_agent_offer":
        env.VERIFY_NO_AGENT_OFFER = "true";
        break;

      default:
        console.warn(`[scenario-bridge] Unknown step action: "${step.action}" — ignored.`);
    }
  }

  return env;
}

/**
 * Resolve {{vocabulary.*}} template references in a scenario using org vocabulary.
 * Returns a deep copy with all references resolved.
 *
 * @param {object} scenario - Declarative scenario with possible {{vocabulary.*}} refs
 * @param {object} vocabulary - Org vocabulary (from discovery or profile)
 * @returns {object} Resolved scenario
 */
export function resolveVocabulary(scenario, vocabulary) {
  if (!vocabulary) return scenario;
  const json = JSON.stringify(scenario);
  const resolved = json.replace(/\{\{vocabulary\.([^}]+)\}\}/g, (match, path) => {
    const value = path.split(".").reduce((obj, key) => obj?.[key], vocabulary);
    if (value === undefined || value === null) {
      console.warn(`[vocabulary] Unresolved reference: ${match}`);
      return match;
    }
    return typeof value === "string" ? value : JSON.stringify(value);
  });
  return JSON.parse(resolved);
}

/**
 * Pretty-print what the bridge will produce (for dry-run / debugging).
 */
export function printBridgeMapping(scenario, defaults) {
  const env = scenarioToEnv(scenario, defaults);
  const lines = [`Scenario: ${scenario.id}`];
  lines.push(`  Steps: ${(scenario.steps ?? []).map((s) => s.action).join(" → ")}`);
  lines.push(`  Env vars (${Object.keys(env).length}):`);
  for (const [key, value] of Object.entries(env)) {
    lines.push(`    ${key}=${value}`);
  }
  return lines.join("\n");
}
