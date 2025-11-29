# WARP.md

This file provides guidance to WARP (warp.dev) when working with code in this repository.

## Project Overview

LoSpeak is a minimalistic peer-to-peer voice chat application for local networks. It uses WebRTC for direct audio streaming between peers, with PartyKit handling WebSocket-based signaling.

## Development Commands

```bash
# Run SvelteKit dev server (http://localhost:5173)
npm run dev

# Run PartyKit signaling server (ws://localhost:1999)
npm run dev:party

# Run both servers simultaneously (recommended for development)
npm run dev:all

# Type check
npm run check

# Build for production
npm run build

# Deploy PartyKit to Cloudflare
npm run party:login   # First time only
npm run party:deploy
```

## Architecture

### Signaling Flow
```
Browser A ←──WebSocket──→ PartyKit ←──WebSocket──→ Browser B
    │                     (room)                      │
    └──────────────── WebRTC P2P ─────────────────────┘
                    (direct audio)
```

### Key Components

**`party/index.ts`** - PartyKit signaling server
- Handles room-based peer discovery
- Relays WebRTC signaling messages (offer/answer/ICE candidates)
- Generates elegant display names ("Quiet Ember", "Silver Drift")

**`src/lib/rtc.ts`** - WebRTC connection management
- `PeerConnection` class wraps RTCPeerConnection
- `createAudioAnalyzer()` provides audio level detection for speaking indicators

**`src/lib/noise.ts` + `src/lib/vad-noise.ts`** - Audio processing
- Uses `@jitsi/rnnoise-wasm` for ML-based noise suppression via RNNoise neural network
- Key innovation: VAD (Voice Activity Detection) gating—RNNoise returns a voice probability score (0-1) with each processed frame. Instead of just reducing noise, we completely silence audio when VAD score < threshold (default 85%)
- This eliminates keyboard clicks, mouse sounds, fans, and background noise that RNNoise alone would only attenuate
- Processing chain: Raw audio → 480-sample frames → RNNoise WASM → VAD gate → Output (or silence)
- Fallback chain: VAD-gated RNNoise → Insertable Streams (Chrome) → AudioWorklet (Firefox)

**`src/lib/types.ts`** - Shared TypeScript types for signaling messages

**`src/routes/+page.svelte`** - Main UI component (Svelte 5 runes)
- Uses `$state()` for reactive state
- Audio processing chain: Raw mic → GainNode → (optional) RNNoise VAD → WebRTC

### Environment Variables

- `VITE_PARTYKIT_HOST` - PartyKit server URL (defaults to `localhost:1999` in dev)

### Deployment

1. Deploy PartyKit with `npm run party:deploy`
2. Set `VITE_PARTYKIT_HOST` to the deployed PartyKit URL
3. Deploy SvelteKit to Vercel (adapter-vercel configured)
