# Scenario Reference

## Declarative Scenario Format (v2)

Scenarios are defined as JSON — no code to write:

```json
{
  "id": "ivr-support-queue-branch",
  "description": "DTMF 1 routes to Support Queue",
  "callTrigger": {
    "mode": "connect_ccp",
    "ivrMode": "speech",
    "ivrLanguage": "en",
    "ivrMaxPromptWaitSec": 15,
    "ivrSteps": [
      { "dtmf": "1", "expect": "press 1|support", "label": "Support Queue" }
    ]
  },
  "steps": [
    { "action": "preflight" },
    { "action": "start_supervisor", "queue": "Support Queue", "observeAgentOffer": true },
    { "action": "trigger_call" },
    { "action": "detect_incoming", "timeoutSec": 120 },
    { "action": "accept_call" },
    { "action": "verify_screen_pop" }
  ],
  "expect": [
    { "type": "e2e.call_connected", "equals": true },
    { "type": "e2e.supervisor_queue_observed", "queue": "Support Queue" },
    { "type": "e2e.screen_pop_detected", "equals": true }
  ]
}
```

## Available Step Actions

| Category | Actions |
|----------|---------|
| Orchestration | `preflight`, `trigger_call`, `detect_incoming`, `accept_call`, `decline_call` |
| IVR & Prompts | `send_dtmf_sequence`, `wait_for_ivr_prompt`, `listen_for_prompt` |
| Verification | `verify_screen_pop`, `verify_transcript`, `verify_voicecall_record`, `verify_prompt_played` |
| Conversation | `play_agent_audio`, `play_caller_audio`, `wait_for_transcript`, `hold_call`, `resume_call` |
| Call Lifecycle | `end_call`, `complete_acw`, `wait_for_disconnect` |
| Voicemail/Callback | `leave_voicemail`, `request_callback`, `verify_voicemail_created`, `verify_callback_created` |
| Supervisor | `start_supervisor`, `verify_business_hours_routing` |

## Natural Language Authoring

Write tests in plain English — compiled to executable JSON:

```text
Scenario: Unknown caller reaches Service queue
Given an unknown caller calls the support number
When caller presses 1 for Service
Then the system should offer the call to an available Service agent
And a VoiceCall record should be created in Salesforce
And the agent should see incoming toast and Accept button
```

The NL compiler maps natural language patterns to scenario DSL steps. See [natural-language-authoring.md](natural-language-authoring.md) for the full authoring guide.
