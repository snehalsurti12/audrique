# Natural Language Authoring

Use natural language for authoring, then compile to canonical scenario JSON.

## Authoring template

```text
Scenario: Unknown caller reaches Service queue
Given an unknown caller calls the support number
When caller presses 1 for Service
Then the system should offer the call to an available Service agent
And a VoiceCall record should be created in Salesforce
And a new Case should be created with Origin=Phone and Status=New
And the VoiceCall should be linked to that Case
And the agent should see incoming toast and Accept button
```

## Compiler mapping rules

- `unknown caller` -> `caller.contactExists=false`
- `presses N` -> `steps += { "action": "send_dtmf", "value": "N" }`
- `offer to agent` -> `connect.agent_offer=true`
- `VoiceCall created` -> `sf.attendance.voicecall_created=true`
- `Case created with ...` -> `sf.attendance.case_created=true` + `fields`
- `linked to Case` -> `sf.attendance.voicecall_linked_case=true`
- `incoming toast` -> `sf.ui.incoming_toast_visible=true`
- `Accept button` -> `sf.ui.accept_button_visible=true`

## Ambiguity handling

Compiler should fail if these are missing:

- entry phone number (`entryPoint`)
- caller number (`caller.phone`)
- queue/agent target when specified
- exact expected record field values when stated

## Output

Compiler must emit JSON compliant with:

- `schemas/scenario.schema.json`
