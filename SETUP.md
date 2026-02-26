# Audrique Setup Guide

Step-by-step guide to configuring Audrique for your Salesforce + Amazon Connect environment.

## Prerequisites

| Requirement | Minimum Version | Notes |
|-------------|----------------|-------|
| Node.js | 18+ | `node --version` to check |
| Salesforce org | Service Cloud Voice enabled | Lightning Experience required |
| Amazon Connect | Linked to SF org | CCP v2 endpoint needed |
| Chromium | Installed via Playwright | Auto-installed in setup |
| FFmpeg | Any recent version | Optional — needed for video merge only |
| Twilio account | — | Optional — for automated call triggering |

## 1. Install

```bash
git clone https://github.com/your-org/audrique.git
cd audrique
npm install
npx playwright install chromium
```

## 2. Create an Instance Profile

An **instance profile** is an `.env` file that holds all configuration for one Salesforce + Connect environment. You can have multiple profiles (dev, staging, production) and switch between them.

```bash
cp instances/default.env.example instances/myorg.env
```

Edit `instances/myorg.env` with your org details. The sections below explain each group of settings.

### Register the Profile

Add your instance to `instances/profiles.json`:

```json
{
  "defaultInstance": "myorg",
  "profiles": [
    {
      "id": "myorg",
      "label": "My Salesforce Org",
      "customer": "Internal",
      "envFile": "instances/myorg.env",
      "salesforce": {
        "loginUrl": "https://test.salesforce.com",
        "appName": "Service Console"
      },
      "connect": {
        "region": "us-west-2",
        "instanceAlias": "your-connect-alias"
      },
      "discovery": {
        "autoDiscover": true,
        "cacheTtlMinutes": 60
      }
    }
  ]
}
```

### Switch Between Instances

```bash
# List all configured instances
npm run instance:list

# Set active instance
npm run instance:use -- myorg

# Or override per-command
INSTANCE=myorg npm run instance:test:e2e
```

## 3. Configure Salesforce

These are the minimum required settings in your `.env` file:

```bash
# Login endpoint
SF_LOGIN_URL=https://test.salesforce.com        # Sandbox
# SF_LOGIN_URL=https://login.salesforce.com      # Production

# Credentials
SF_USERNAME=your.user@company.com
SF_PASSWORD=YourPassword123

# Your org's Lightning URL
SF_INSTANCE_URL=https://your-org.sandbox.lightning.force.com

# App to open after login (must be a Lightning Console App)
SF_APP_NAME=Service Console
```

**Optional Salesforce settings:**

| Variable | Default | Purpose |
|----------|---------|---------|
| `SF_SERVICE_CONSOLE_URL` | — | Direct URL to Service Console (skips app switching) |
| `SF_EMAIL_CODE` | — | 2FA verification code (if org requires it) |
| `SF_APP_URL` | — | Direct app URL (overrides SF_APP_NAME) |
| `SF_STORAGE_STATE` | `.auth/sf-agent.json` | Where to save browser session |

### Required Custom Fields

Audrique correlates test runs to Salesforce records using custom fields. Create these in your org:

| Object | Field API Name | Type | Purpose |
|--------|---------------|------|---------|
| VoiceCall | `Test_Run_Id__c` | Text(255) | Links call record to test run |
| Case | `Test_Run_Id__c` | Text(255) | Links case to test run |
| AgentWork | `Test_Run_Id__c` | Text(255) | (Optional) Tracks routing assignment |

**How to create:**
1. Setup → Object Manager → VoiceCall → Fields & Relationships → New
2. Type: Text, Length: 255, Label: "Test Run Id", API Name: `Test_Run_Id__c`
3. Repeat for Case (and optionally AgentWork)

### Salesforce User Permissions

The test user needs:
- **Service Cloud Voice** license
- **Omni-Channel** agent access
- Access to the Service Console app
- Read access to VoiceCall, Case, AgentWork objects
- (For supervisor tests) Access to Command Center / Omni Supervisor

## 4. Configure Amazon Connect

```bash
# Your Connect instance alias (the subdomain part)
# Examples:
#   CONNECT_INSTANCE_ALIAS=my-instance
#   CONNECT_INSTANCE_ALIAS=my-instance.my.connect.aws
CONNECT_INSTANCE_ALIAS=your-connect-alias

# AWS credentials (for auto-login to Connect console)
AWS_USERNAME=your-aws-user
AWS_PASSWORD=YourAWSPassword
AWS_ACCOUNT_ID=123456789012

# Region where your Connect instance lives
CONNECT_CONSOLE_REGION=us-west-2
```

The CCP URL is **automatically derived** from the instance alias. If you need to override:

```bash
CONNECT_CCP_URL=https://your-instance.my.connect.aws/ccp-v2/
```

**Optional Connect settings:**

| Variable | Default | Purpose |
|----------|---------|---------|
| `CONNECT_STORAGE_STATE` | `.auth/connect-ccp.json` | Where to save CCP session |
| `CONNECT_LOGIN_TIMEOUT_SEC` | `900` | Max wait for CCP login |
| `CONNECT_AUTO_AWS_LOGIN` | `true` | Auto-fill AWS credentials |
| `CONNECT_AUTO_NAVIGATE_FROM_CONSOLE` | `false` | Auto-navigate from AWS console to CCP |
| `AWS_MFA_CODE` | — | MFA code if your AWS account requires it |

## 5. Configure Twilio (Optional)

Twilio enables **automated call triggering** — Audrique places a real phone call to your Connect entry point number. Without Twilio, you trigger calls manually or via the CCP dialer.

```bash
TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_AUTH_TOKEN=your_auth_token
TWILIO_FROM_NUMBER=+14155550123

# Your Connect phone number (where Twilio calls)
CONNECT_ENTRYPOINT_NUMBER=+18005550199
```

Set the call trigger mode in your scenario or `.env`:

```bash
CALL_TRIGGER_MODE=twilio          # Automated via Twilio
# CALL_TRIGGER_MODE=connect_ccp   # Dial from CCP softphone
# CALL_TRIGGER_MODE=manual        # You place the call yourself
```

## 6. Secrets Management

Audrique supports two backends for managing sensitive values.

### Environment Backend (Default)

Credentials are stored in `.env` files (gitignored) and referenced at runtime:

```bash
SECRETS_BACKEND=env

# Direct values (simple, for local dev)
SF_PASSWORD=YourPassword123

# Or reference an environment variable
SF_PASSWORD_REF=SF_PASSWORD_SECRET
# At runtime: export SF_PASSWORD_SECRET=YourPassword123
```

### Vault Backend (Enterprise)

For production/CI environments using HashiCorp Vault:

```bash
SECRETS_BACKEND=vault
REGULATED_MODE=true

# References point to Vault paths
SF_PASSWORD_REF=secret/data/voice/myorg/salesforce#password
AWS_PASSWORD_REF=secret/data/voice/myorg/aws#password

# Set at runtime (never in .env files)
# export VAULT_ADDR=https://vault.example.com
# export VAULT_TOKEN=s.xxxxxxxxxx
```

When `REGULATED_MODE=true`, Audrique blocks plaintext sensitive values in config files — only `*_REF` references are allowed.

## 7. Capture Authentication Sessions

Before running headless tests, capture browser sessions once. These are saved to `.auth/` and reused on subsequent runs.

### Salesforce Session

```bash
INSTANCE=myorg npm run instance:auth:sf
```

This opens a Chromium browser, logs into Salesforce, navigates to the Service Console, and saves the session to `.auth/sf-agent.json`.

**What to expect:**
1. Browser opens to SF login page
2. Credentials are auto-filled
3. 2FA prompt appears (if enabled) — enter code or set `SF_EMAIL_CODE`
4. Browser navigates to Service Console
5. Session saved — browser closes

### Amazon Connect Session

```bash
INSTANCE=myorg npm run instance:auth:connect
```

This opens Chromium, logs into the AWS Console, navigates to your Connect instance's CCP, and saves the session.

**What to expect:**
1. Browser opens to AWS sign-in page
2. Credentials auto-filled (if `CONNECT_AUTO_AWS_LOGIN=true`)
3. MFA prompt (if enabled) — enter code
4. Navigates to Connect CCP
5. CCP health check passes
6. Session saved — browser closes

### Session Tips

- Sessions expire after several hours — re-run auth commands when you see "Telephony provider is not logged in"
- Sessions are stored in `.auth/` which is gitignored
- Use `SF_SKIP_LOGIN=true` (default) to reuse saved sessions

## 8. Run Your First Test

### Dry Run (Validate Without Executing)

```bash
INSTANCE=myorg npm run instance:test:e2e:v2:dry
```

This validates your suite JSON and prints the scenario-to-environment mapping without running any browsers.

### Single Test Run

```bash
INSTANCE=myorg npm run instance:test:ui:state
```

Runs the base Playwright spec once — triggers a call, detects incoming, accepts, verifies screen pop.

### Full E2E Suite

```bash
# Run the declarative v2 suite (recommended)
INSTANCE=myorg npm run instance:test:e2e:v2

# Or via CLI
INSTANCE=myorg npx audrique run
```

### With Video Recording

```bash
# Run with video capture
INSTANCE=myorg PW_VIDEO_MODE=on npm run instance:test:ui:state

# Merge parallel recordings after
npm run merge:videos
```

## 9. Playwright Settings

| Variable | Default | Purpose |
|----------|---------|---------|
| `PW_HEADLESS` | `true` | Run browsers headless (set `false` to watch) |
| `PW_VIDEO_MODE` | `off` | `off` / `on` / `retain-on-failure` / `on-first-retry` |
| `PW_USE_FAKE_MEDIA` | `true` | Use fake audio/video devices in browser |
| `PW_FAKE_AUDIO_FILE` | — | Path to WAV file for fake audio input |

To watch tests execute in real time:

```bash
INSTANCE=myorg PW_HEADLESS=false npm run instance:test:ui:state
```

## 10. Voice Test Behavior

These control how calls are handled during tests:

| Variable | Default | Purpose |
|----------|---------|---------|
| `OMNI_TARGET_STATUS` | `Available` | Presence status to set before test |
| `VOICE_RING_TIMEOUT_SEC` | `90` | Max wait for incoming call ring |
| `PROVIDER_SYNC_WAIT_SEC` | `20` | Wait for telephony provider sync |
| `PROVIDER_LOGIN_TIMEOUT_SEC` | `300` | Max wait for provider login |

### Supervisor Settings

| Variable | Default | Purpose |
|----------|---------|---------|
| `VERIFY_SUPERVISOR_QUEUE_WAITING` | `false` | Check supervisor sees call in queue |
| `VERIFY_SUPERVISOR_AGENT_OFFER` | `true` | Check supervisor sees agent offered |
| `SUPERVISOR_APP_NAME` | `Supervisor Console` | SF app name for supervisor context |
| `SUPERVISOR_QUEUE_NAME` | — | Queue to monitor in Command Center |
| `SUPERVISOR_AGENT_NAME` | — | Agent name to look for in offers |

### IVR / DTMF Settings

| Variable | Default | Purpose |
|----------|---------|---------|
| `CONNECT_CCP_IVR_DIGITS` | — | DTMF digits to send after call connects |
| `CONNECT_CCP_IVR_INITIAL_DELAY_MS` | `0` | Delay before sending first digit |
| `CONNECT_CCP_IVR_INTER_DIGIT_DELAY_MS` | `420` | Delay between digits |
| `CONNECT_CCP_IVR_POST_DELAY_MS` | `1200` | Delay after last digit |
| `CONNECT_CCP_DTMF_MIN_CALL_ELAPSED_SEC` | `4` | Min call duration before sending DTMF |

## Troubleshooting

### "Telephony provider is not logged in"
Connect CCP session expired. Re-run:
```bash
INSTANCE=myorg npm run instance:auth:connect
```

### "You have logged in from another location"
Session conflict — typically happens when running multiple tests or supervisor contexts share the same SF user. Re-run:
```bash
INSTANCE=myorg npm run instance:auth:sf
```

### Omni-Channel shows Offline
The agent's Omni-Channel disconnected. This can happen after session conflicts. Re-capture the SF session and ensure only one browser context uses the agent user.

### Call never arrives
1. Check `CALL_TRIGGER_MODE` matches your setup (twilio/connect_ccp/manual)
2. Verify `CONNECT_ENTRYPOINT_NUMBER` is correct
3. Ensure agent is Online in Omni-Channel
4. Check Connect routing rules — the call flow must route to the correct queue

### FFmpeg not found
FFmpeg is only needed for video merge. Install it:
```bash
# macOS
brew install ffmpeg

# Ubuntu/Debian
sudo apt install ffmpeg

# Or skip video merge — tests still run fine without it
```

## File Reference

| Path | Purpose |
|------|---------|
| `instances/default.env.example` | Template for new instance profiles |
| `instances/profiles.json` | Profile registry (tracks all instances) |
| `instances/<name>.env` | Instance config (gitignored) |
| `.auth/sf-agent.json` | Saved Salesforce session (gitignored) |
| `.auth/connect-ccp.json` | Saved Connect CCP session (gitignored) |
| `scenarios/e2e/full-suite-v2.json` | Default test suite (v2 declarative format) |
| `test-results/` | Test output, screenshots, videos |
