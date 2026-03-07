# Video Evidence Pipeline

Three parallel recording streams captured simultaneously, merged with FFmpeg.

## Usage

```bash
# Run with video capture
INSTANCE=myorg npm run instance:test:ui:state:video

# Merge recordings into evidence video
npm run merge:videos

# Create speed-modulated highlight reel from full suite run
npm run highlight:reel

# Build annotated demo video with title cards and phase annotations
node scripts/build-demo-video.mjs
```

## Evidence Output

Each scenario produces:

- **Agent browser recording** — Salesforce UI (Omni-Channel, screen pop, transcript)
- **CCP browser recording** — Connect softphone (dial, call state, hold/resume)
- **Supervisor browser recording** — Command Center (queue monitoring, agent offers, metrics)
- **Merged video** — Timeline-based speed modulation combining all streams
- **Annotated demo** — Phase banners, title cards, and narration overlays

## Recording Streams

```
Scenario starts
  ├── Agent Browser ──────► continuous WebM capture (Playwright recordVideo)
  ├── CCP Browser ────────► continuous WebM capture
  ├── Supervisor Browser ─► continuous WebM capture
  ├── Steps execute, each logs timestamp to context.stepMarkers[]
  ├── Scenario ends → page.close() finalizes videos
  └── Post-run: VideoMerger syncs and combines streams via FFmpeg
```

## Merge Modes

| Mode | Layout | Use Case |
|------|--------|----------|
| **Story** | 3-way split (Agent + CCP + Supervisor) | Full evidence review |
| **Highlight** | Speed-modulated single stream | Quick demo reel |
| **Annotated demo** | Title cards + phase banners + recording | YouTube / stakeholder demos |

## Requirements

- **FFmpeg** — System dependency for video merge (`brew install ffmpeg` or `apt install ffmpeg`)
- **ffmpeg-static** — npm fallback (`npm install ffmpeg-static`, included in dependencies)
