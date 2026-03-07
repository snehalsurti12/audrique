# Setup Guide

## Salesforce Org Setup

Required custom fields for test correlation:

| Object | Field | Purpose |
|--------|-------|---------|
| VoiceCall | `Test_Run_Id__c` | Correlates test run to call record |
| Case | `Test_Run_Id__c` | Links generated case to test |
| AgentWork | `Test_Run_Id__c` | (Optional) Tracks routing assignment |

These fields allow Audrique to query "find the VoiceCall created by this specific test run" via SOQL.

## Intelligent Org Auto-Discovery

Audrique **autonomously discovers** your Salesforce org configuration via SOQL — zero hardcoding required:

| Discovery | Source | Auto-Configured |
|-----------|--------|-----------------|
| Presence statuses | `ServicePresenceStatus` | Agent online/offline states |
| Queues | `Group WHERE Type='Queue'` | Routing targets |
| Skills | `Skill` + `ServiceResourceSkill` | Skill-based routing |
| Service channels | `ServiceChannel` | Channel configuration |
| Business hours | `OperatingHours` + `TimeSlot` | After-hours routing |
| Routing configs | `RoutingConfiguration` | Queue/skill routing |
| Queue capabilities | DOM + metadata | Voicemail/callback detection |

Discovery results are cached and used as `{{vocabulary.*}}` references in scenarios — scenarios adapt to any org without code changes.

## Project Structure

```
audrique/
├── packages/
│   ├── core/                  # Types, runner, shared interfaces
│   ├── provider-twilio/       # Twilio call provider
│   ├── verifier-salesforce/   # SOQL-based backend assertions
│   ├── verifier-connect/      # Connect CTR verifier
│   └── verifier-ui-playwright/
│       ├── sfOmniChannel.ts   # Omni-Channel status management
│       ├── sfCallDetection.ts # Incoming call detection
│       ├── sfCallAccept.ts    # Call accept automation
│       ├── sfScreenPop.ts     # VoiceCall screen pop verification
│       ├── sfTranscript.ts    # Real-time transcript capture
│       ├── sfSupervisorObserver.ts  # Supervisor queue monitoring
│       ├── sfOrgDiscovery.ts  # Auto-discovery via SOQL + DOM
│       ├── connectCcpDialer.ts     # CCP softphone automation
│       ├── parallelDialer.ts      # Multi-provider parallel call placement
│       ├── sfAgentforceObserver.ts # Agentforce tab monitoring
│       ├── twilioInbound.ts       # Twilio REST API inbound dialer
│       ├── ivrSpeechDetector.ts   # Browser-side IVR speech/silence detection
│       └── ivrWhisperTranscriber.ts # Local whisper.cpp transcription
├── scenarios/
│   ├── e2e/full-suite-v2.json # 3 proven test scenarios
│   └── examples/              # Reference scenarios
├── webapp/                    # Scenario Studio (visual builder)
├── scripts/                   # CLI tools, auth capture, video merge
├── instances/                 # Org-specific config (gitignored)
└── docs/                      # Architecture docs, assertion catalog
```

## npm Scripts

| Script | Purpose |
|--------|---------|
| `npm run studio` | Start Scenario Studio at localhost:4200 |
| `npm run instance:test:e2e` | Run full E2E suite |
| `npm run instance:test:e2e:v2` | Run v2 declarative suite |
| `npm run instance:auth:sf` | Capture Salesforce session |
| `npm run instance:auth:connect` | Capture Connect CCP session |
| `npm run merge:videos` | Merge parallel recording streams |
| `npm run highlight:reel` | Generate highlight video from suite run |
| `npm run typecheck` | TypeScript type checking |

## CLI Usage

```bash
# Run default suite with automatic session refresh
audrique run --refresh-auth

# Run a specific suite file
audrique run scenarios/e2e/my-suite.json

# Dry run — validate without executing
audrique run --dry-run

# Capture auth sessions
audrique auth
```

Session validity is checked automatically before each suite run. If sessions are expired, the runner exits with clear instructions. Use `audrique run --refresh-auth` to auto-refresh before running.
