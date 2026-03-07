# Changelog

## [0.5.0] — 2026-03-07

### Added
- Parallel Agentforce testing — simultaneous multi-provider calls (CCP + Twilio) to validate AI agent concurrency
- Twilio inbound dialer — REST API call placement as a parallel call source
- Agentforce supervisor observer — Command Center Agentforce tab monitoring with KPI card reading
- UI-driven parallel config — Scenario Studio "AI Agent" call outcome with multi-source and verify toggle
- Connect GetFederationToken auth — zero-browser CCP authentication via AWS API (~2s per agent)
- Demo video pipeline — FFmpeg-based demo generation with title cards, phase annotations, speed modulation

## [0.4.0] — 2026-03-04

### Added
- Fully UI-driven configuration — all org-specific values configurable from Scenario Studio
- Session resilience — HTTP liveness probes validate sessions before each suite run
- Two-tab supervisor monitoring — dedicated In-Progress Work tab
- Run from UI — select suite and run from browser with live SSE streaming

### Fixed
- Session conflict banners resolved via page reload instead of fragile button clicking
- Stale Chromium processes killed between scenarios

## [0.3.0] — 2026-03-01

### Added
- Real-time IVR transcription via local whisper.cpp (ggml-small, 99 languages)
- Transcription-driven DTMF navigation with `expect` keyword matching
- Session validity gate — checks SF + Connect sessions before test execution
- `SKIP_SESSION_CHECK` env var to bypass session validation
- `ivrLanguage` and `ivrTranscriptionBackend` scenario config options
- Pipe-separated keyword patterns in IVR steps (`"press 1|support"`)

### Fixed
- WebM EBML header missing on second/subsequent audio extractions
- Entry number placeholder replaced with real Connect number in all suite files
- Reduced default timeouts (ringSec 90→45, suite ~10 min vs 30+)

### Changed
- Default suite trimmed from 9 aspirational to 3 proven scenarios
- IVR speech mode waits 2 s (not 8 s) for WebRTC before listening

## [0.2.0] — 2026-02-15

### Added
- Speech-silence IVR detection (browser-side AnalyserNode)
- Advanced Settings UI (33 system-wide settings from Scenario Studio)
- Settings injection pipeline (5-layer priority chain)
- Docker support with Vault integration and pre-flight health checks
- Setup Menu in Scenario Studio

## [0.1.0] — 2026-01-20

### Added
- Initial release: SCV E2E testing framework
- Declarative JSON v2 scenario format
- Scenario Studio visual builder
- 4 parallel browser agents (Agent, CCP, Supervisor, Backend)
- Video evidence pipeline with FFmpeg merge
- Vault-based secrets management
