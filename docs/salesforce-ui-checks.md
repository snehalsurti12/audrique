# Salesforce UI Checks

The Playwright skeleton uses `data-testid` selectors as placeholders.

## Required checks

- incoming toast visible
- accept button visible
- active call panel visible after accept
- screen pop record type
- wrap-up panel visible after hangup
- required disposition enforcement visible

## Selector strategy

1. Prefer `data-testid` attributes in custom LWC/Aura components.
2. If unavailable, use stable ARIA roles/labels.
3. Avoid brittle class-name selectors from Salesforce generated markup.

## Mapping file

Update selectors in:

- `packages/verifier-ui-playwright/src/SalesforceVoiceUiVerifier.ts`

Current defaults:

- `[data-testid="voice-incoming-toast"]`
- `[data-testid="voice-accept"]`
- `[data-testid="voice-active-panel"]`
- `[data-testid="voice-wrapup-panel"]`
- `[data-testid="voice-disposition-required"]`
- `[data-testid="screen-pop-header"]`

## CI recommendation

- Run UI tests serially for one dedicated agent user.
- Keep UI suite as smoke only (5-10 tests).
- Run backend attendance assertions as main regression suite.
