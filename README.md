# Voice Test Auto

Starter framework for testing Salesforce Service Cloud Voice (Amazon Connect) flows with:

- pluggable call providers (`Twilio` first, others later)
- backend attendance assertions (Salesforce + Connect)
- UI assertions (Playwright smoke checks)
- scenario-driven execution (`JSON` canonical format)

## Project layout

- `docs/assertion-catalog.md`: assertion keys and payloads
- `docs/natural-language-authoring.md`: NL template and compiler mapping
- `docs/salesforce-ui-checks.md`: UI assertion and selector guidance
- `schemas/scenario.schema.json`: canonical scenario schema
- `scenarios/examples/`: sample executable scenarios
- `packages/core/`: runner and shared types
- `packages/provider-twilio/`: Twilio call provider adapter
- `packages/verifier-salesforce/`: attendance verifier skeleton
- `packages/verifier-ui-playwright/`: UI harness and Playwright tests

## Quick start

1. Install dependencies:

```bash
npm install
```

2. Create an instance config file once:

```bash
cp instances/default.env.example instances/winfield.env
```

Fill `instances/winfield.env` with your Salesforce/Connect values.

3. Run Playwright tests (inbound voice E2E):

```bash
INSTANCE=winfield npm run instance:test:ui
```

4. Optional: create reusable authenticated Salesforce session state (recommended for sandbox identity prompts):

```bash
INSTANCE=winfield npm run instance:auth:sf
```

5. Run inbound call test using saved state (skips login when `SF_SKIP_LOGIN=true`):

```bash
INSTANCE=winfield npm run instance:test:ui:state
```

For tester-friendly evidence (video on every run):

```bash
INSTANCE=winfield npm run instance:test:ui:state:video
```

Videos are saved under `test-results/`.

Run full end-to-end suite (multiple scenarios in one command):

```bash
INSTANCE=personal npm run instance:test:e2e
```

Default suite file:

- `scenarios/e2e/full-suite.json`

Optional overrides:

- `E2E_SUITE_FILE=<path>` use a custom suite file
- `E2E_SUITE_DRY_RUN=true` validate/print scenario plan without running tests
- `SUPERVISOR_QUEUE_SUPPORT_NAME`, `SUPERVISOR_QUEUE_BASIC_NAME` override default queue names (`Support Queue`, `SCV Basic Queue`)
- `E2E_SUPPORT_DTMF`, `E2E_SUPPORT_DTMF_DELAY_MS`, `E2E_DTMF_MIN_CALL_ELAPSED_SEC` tune IVR branch timing

Suite outputs:

- `test-results/e2e-suite/<suite>-<timestamp>/suite-summary.json`
- per-scenario summaries under each scenario folder
- per-scenario Playwright artifacts and merged E2E video (when available)

## Security-first secret handling

All `instance:*` commands run through `scripts/run-instance.mjs`, which now supports:

- `SECRETS_BACKEND=env` or `SECRETS_BACKEND=vault`
- `*_REF` secret references (for example `SF_PASSWORD_REF`)
- `REGULATED_MODE=true` guardrails (blocks plaintext sensitive values in `instances/*.env`)

### Option A: env-backed references (works anywhere)

In your instance file:

```bash
SECRETS_BACKEND=env
REGULATED_MODE=true
SF_USERNAME=
SF_USERNAME_REF=SF_USERNAME_SECRET
SF_PASSWORD=
SF_PASSWORD_REF=SF_PASSWORD_SECRET
```

At runtime (shell/CI):

```bash
export SF_USERNAME_SECRET='agent@example.com'
export SF_PASSWORD_SECRET='...'
INSTANCE=winfield npm run instance:auth:sf
```

### Option B: Vault references

In your instance file:

```bash
SECRETS_BACKEND=vault
REGULATED_MODE=true
SF_USERNAME=
SF_USERNAME_REF=kv/data/voice/sf#username
SF_PASSWORD=
SF_PASSWORD_REF=kv/data/voice/sf#password
```

At runtime:

```bash
export VAULT_ADDR='https://vault.example.com'
export VAULT_TOKEN='...'
INSTANCE=winfield npm run instance:auth:sf
```

Notes:

- Vault refs support `path#field` or `path:field` (default field is `value`).
- Keep `instances/*.env` non-secret; inject actual secret values/tokens at runtime.

This test will:

- trigger inbound call using selected mode (`manual`, `twilio`, or `connect_ccp`)
- wait for inbound call indication in Salesforce UI
- auto-accept (when offered) and verify a `VoiceCall` screen pop appears

Recommended mode for your setup:

- `CALL_TRIGGER_MODE=connect_ccp`
- `CONNECT_ENTRYPOINT_NUMBER=+1...`
- `CONNECT_CCP_URL=https://<instance>.my.connect.aws/ccp-v2/`
- `CONNECT_STORAGE_STATE=.auth/connect-ccp.json`

Manual fallback while Twilio trial restrictions block outbound dialing:

```bash
INSTANCE=winfield npm run instance:test:ui:state
```

If provider shows `NotLoggedIn`, capture provider login in the automation browser context once:

```bash
INSTANCE=winfield npm run instance:auth:provider
```

In the opened browser window, log in to Phone/Connection Status (Amazon Connect CCP). The script saves updated session state for future headless runs.

If you want to capture Amazon Connect CCP auth directly (outside Salesforce), run:

```bash
INSTANCE=winfield npm run instance:auth:connect
```

This opens a headed browser for manual sign-in and saves session state once CCP is active.

AWS auto-login during `instance:auth:connect`:

- Provide `AWS_USERNAME` and `AWS_PASSWORD` (or `*_REF` via secrets backend)
- Keep `CONNECT_AUTO_AWS_LOGIN=true` (default)
- Optional: set `AWS_MFA_CODE` for one-time MFA code autofill

If AWS sign-in flow differs (SSO/custom prompt), script falls back to manual completion in the same window.

## Why one-time auth commands still exist

- Test runs can be fully automated after session state is captured.
- Authentication capture is a separate bootstrap because Salesforce/Connect may require interactive login, prompts, or federation.
- Once state is captured, daily run is just:

```bash
INSTANCE=winfield npm run instance:test:ui:state
```

In `manual` mode, place a real call to your Connect entry number during the wait window.

`connect_ccp` mode details:

- Test opens CCP in a separate browser context using `CONNECT_STORAGE_STATE`
- Dials `CONNECT_ENTRYPOINT_NUMBER` from CCP
- Keeps CCP call alive during Salesforce verification and hangs up in cleanup

Real-time transcript verification (optional):

- Set `VERIFY_REALTIME_TRANSCRIPT=true`
- Optionally set `TRANSCRIPT_EXPECT_PHRASE=<phrase you speak on the call>`
- `TRANSCRIPT_REQUIRE_RIGHT_SIDE=true` asserts widget placement on right side
- `TRANSCRIPT_WAIT_SEC` controls wait window for live transcript updates

Notes:

- Transcript validation needs actual speech on the call while it is active.
- If you run with fake media devices, transcript growth may be limited.

Outcome mode:

- `CALL_EXPECTATION=agent_offer` (default): test expects incoming signal + VoiceCall screen pop.
- `CALL_EXPECTATION=business_hours_blocked`: test expects no inbound offer to agent (use for off-hours routing checks).

Provider sync behavior:

- Before inbound wait, the test opens `Connection Status`, clicks `Sync` when available, and waits up to `PROVIDER_SYNC_WAIT_SEC` (default `20`) for routable status.

5. Validate scenario file:

Use `schemas/scenario.schema.json` with your JSON schema validator in CI.

## Salesforce setup assumptions

- Add a custom field for correlation ID:
  - `VoiceCall.Test_Run_Id__c`
  - `Case.Test_Run_Id__c`
  - optional `AgentWork.Test_Run_Id__c`
- Ensure your flow or integration writes `test_run_id` from call metadata.
- Update UI selectors in `packages/verifier-ui-playwright/src/SalesforceVoiceUiVerifier.ts` for your org.

## Status

This is a scaffold meant to be extended with:

- real Twilio credentials and call control
- real Salesforce REST/SOQL queries
- Amazon Connect CTR integrations
- org-specific UI selectors
