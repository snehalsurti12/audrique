# Audrique — Agentic Voice Testing for Contact Centers

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-18+-green.svg)](https://nodejs.org)
[![Playwright](https://img.shields.io/badge/Playwright-powered-45ba4b.svg)](https://playwright.dev)
[![Salesforce](https://img.shields.io/badge/Salesforce-SCV-00A1E0.svg)](https://www.salesforce.com/products/service-cloud-voice/)

**Agentic AI-ready end-to-end testing framework for enterprise contact centers.** Autonomously orchestrates real voice calls, multi-browser CRM verification, and telephony API validation — all in a single declarative test scenario.

> The first open-source tool that tests across telephony, CRM UI, and backend records simultaneously — no mocks, no stubs, real calls.

<div align="center">
  <a href="https://www.youtube.com/watch?v=yukCm70mJ9s">
    <img src="https://img.youtube.com/vi/yukCm70mJ9s/maxresdefault.jpg" alt="Audrique — Automated Voice Testing for Contact Centers" width="720" />
  </a>
  <p><em>Click to watch: Automated Voice Testing for Contact Centers (4:37)</em></p>
</div>

---

## Why Agentic Testing?

Traditional contact center testing is **manual, slow, and siloed**. Each tool covers one layer:

| Traditional Approach | Limitation |
|---------------------|------------|
| **UI tools** (Provar, Selenium) | Test the CRM, can't place real calls |
| **Telephony tools** (Twilio scripts) | Make calls, can't verify what the agent sees |
| **API tools** (Postman) | Query records, can't coordinate timing |
| **Manual QA** | Expensive, slow, non-reproducible |

**Audrique is an autonomous testing agent** that orchestrates all three layers in parallel — because contact center bugs live at the boundaries between systems.

## Key Capabilities

| Capability | Description |
|------------|-------------|
| **Autonomous call orchestration** | Places real calls via Connect CCP or Twilio REST API, navigates IVR menus with DTMF |
| **Parallel Agentforce testing** | Simultaneous multi-provider calls to validate AI agent concurrency and supervisor monitoring |
| **Transcription-driven IVR** | Local whisper.cpp transcribes IVR prompts in ~2.5 s, matches keywords, sends DTMF on match |
| **Multi-agent browser verification** | 3 parallel Playwright sessions (Agent, CCP, Supervisor) |
| **Declarative scenario DSL** | JSON-based scenarios — no code to write |
| **Visual Scenario Studio** | Drag-and-drop wizard builds scenarios at localhost:4200 |
| **Org auto-discovery** | SOQL-powered discovery of queues, skills, routing, business hours |
| **Video evidence capture** | Parallel recording + FFmpeg merge with speed modulation and annotations |
| **Enterprise security** | Vault integration, zero plaintext secrets, session isolation |
| **CI/CD ready** | Headless execution, structured JSON results, exit codes |

## What You Can Test

| Scenario Type | What It Validates |
|---------------|-------------------|
| Inbound call + agent accept | Call routes correctly, screen pop appears, VoiceCall record created |
| IVR navigation (single/multi-level) | DTMF routing, queue assignment, timeout fallback |
| Skill-based routing | Agent skills matched, PendingServiceRouting records correct |
| Supervisor observation | Queue monitoring, agent offer visibility in Command Center |
| Business hours / closed message | After-hours routing, system prompt, auto-disconnect |
| Voicemail | No-agent fallback, voicemail recorded, SF record created |
| Callback | Queue-full handling, callback task created in Salesforce |
| Real-time transcript | Speech captured, transcript panel updates live |
| Hold / resume / ACW | Full call lifecycle with disposition |
| Agentforce (AI agent) | Parallel calls from CCP + Twilio, AI greeting verification, supervisor active count |

## Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                          Scenario Studio                              │
│         Visual wizard for building test scenarios (localhost:4200)     │
│      IVR flowchart builder | Skill routing | Business hours | NLP     │
└────────────────────────┬─────────────────────────────────────────────┘
                         │ declarative JSON v2
                         ▼
┌──────────────────────────────────────────────────────────────────────┐
│                        Agentic Scenario Runner                        │
│        Reads v2 JSON → orchestrates parallel agents → assertions      │
│     Step-based execution | Timeline capture | Video evidence          │
└──────┬──────────────────┬──────────────────┬─────────────────────────┘
       │                  │                  │
       ▼                  ▼                  ▼
┌─────────────┐   ┌──────────────┐   ┌─────────────────┐
│ Call Agent   │   │ Browser      │   │ Backend          │
│              │   │ Agents (x3)  │   │ Verifier         │
│ - Twilio API │   │              │   │                  │
│ - CCP Dialer │   │ - SF Agent   │   │ - SF SOQL        │
│ - DTMF Nav   │   │ - CCP Panel  │   │ - Connect CTR    │
│ - IVR Whisper│   │ - Supervisor │   │ - VoiceCall      │
│              │   │ - Screen Pop │   │ - AgentWork      │
│              │   │ - Transcript │   │ - PSR Records    │
└─────────────┘   └──────────────┘   └─────────────────┘
```

**Four autonomous agents** work in parallel during each test:
1. **Call Agent** — Places real calls via Connect CCP or Twilio, sends DTMF, navigates IVR
2. **SF Agent Browser** — Salesforce console (Omni-Channel status, phone utility, screen pop, transcript)
3. **CCP Agent Browser** — Amazon Connect softphone (dial confirmation, call state, hold/resume)
4. **Supervisor Browser** — Command Center (queue monitoring, agent offers, real-time metrics)

## Quick Start

### Prerequisites

- Node.js 18+
- A Salesforce org with Service Cloud Voice enabled
- Amazon Connect instance linked to the org

### Install

```bash
git clone https://github.com/snehalsurti12/audrique.git
cd audrique
npm install
npx playwright install chromium
```

### Configure

```bash
cp instances/default.env.example instances/myorg.env
# Edit instances/myorg.env with your Salesforce + Connect credentials
```

### Capture Auth Sessions

```bash
INSTANCE=myorg npm run instance:auth:sf
INSTANCE=myorg npm run instance:auth:connect
```

### Run Tests

```bash
# Single test
INSTANCE=myorg npm run instance:test:ui:state

# Full E2E suite
INSTANCE=myorg npm run instance:test:e2e:v2

# Dry run (validate without executing)
INSTANCE=myorg npm run instance:test:e2e:v2:dry
```

### Scenario Studio

```bash
npm run studio
# Open http://localhost:4200
```

Visual wizard for building test scenarios — suite management, connection config, advanced settings, run from browser with live output.

---

## Documentation

- [Setup Guide](docs/setup-guide.md) — Org configuration, project structure, npm scripts, CLI usage
- [Scenario Reference](docs/scenario-reference.md) — Step actions, assertion types, full DSL reference
- [Security](docs/security.md) — Vault integration, credential management, compliance
- [Video Evidence](docs/video-evidence.md) — Recording pipeline, merge modes, output format
- [Platform Support](docs/platform-support.md) — Current support matrix, extensibility architecture
- [Roadmap](docs/roadmap.md) — AI/LLM capabilities, platform expansion plans
- [Changelog](CHANGELOG.md) — Version history and release notes

## Contributing

Contributions welcome. Please:
1. Fork the repo
2. Create a feature branch
3. Follow existing code patterns
4. Test against a real Salesforce + Connect environment
5. Submit a PR with description of changes

## License

[MIT](LICENSE)

---

Built with Playwright, FFmpeg, and a lot of real phone calls.
