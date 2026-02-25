# Assertion Catalog

This catalog defines canonical assertion keys for scenario `expect` blocks.

## Attendance assertions (`sf.attendance.*`)

- `sf.attendance.voicecall_created`
  - `equals`: `true | false`
- `sf.attendance.agentwork_created`
  - `equals`: `true | false`
  - optional `queueDeveloperName`: string
  - optional `agentUsername`: string
- `sf.attendance.offer_state`
  - `equals`: `"offered" | "accepted" | "declined" | "missed" | "abandoned" | "transferred"`
- `sf.attendance.case_created`
  - `equals`: `true | false`
  - optional `fields`: key-value object (example: `{ "Origin": "Phone", "Status": "New" }`)
- `sf.attendance.voicecall_linked_case`
  - `equals`: `true | false`
- `sf.attendance.contact_match`
  - `equals`: `"found" | "not_found"`

## Connect assertions (`connect.*`)

- `connect.flow_path`
  - `equals`: contact flow branch summary string
- `connect.agent_offer`
  - `equals`: `true | false`
- `connect.disconnect_reason`
  - `equals`: reason string from CTR mapping

## UI assertions (`sf.ui.*`)

- `sf.ui.incoming_toast_visible`
  - `equals`: `true | false`
- `sf.ui.accept_button_visible`
  - `equals`: `true | false`
- `sf.ui.call_panel_active`
  - `equals`: `true | false`
- `sf.ui.screen_pop_record_type`
  - `equals`: `"Case" | "Contact" | "Account" | "Lead" | "Unknown"`
- `sf.ui.wrapup_visible`
  - `equals`: `true | false`
- `sf.ui.required_disposition_enforced`
  - `equals`: `true | false`

## Time-bound behavior

Each scenario can define:

```json
{
  "timeouts": {
    "agent_offer_sec": 30,
    "record_creation_sec": 60,
    "ui_render_sec": 15
  }
}
```

## Evidence expectations

Each assertion should capture evidence in test artifacts:

- `assertionKey`
- `pass`
- `observed`
- `expected`
- `source` (`salesforce`, `connect`, `ui`)
- optional IDs (`voiceCallId`, `caseId`, `ctrId`, `agentWorkId`)
