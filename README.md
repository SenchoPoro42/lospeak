# LoSpeak

A beautiful, minimalistic voice chat for local networks. Like SnapDrop, but for voice.

## Features

- **Zero setup** - Just open the URL and start talking
- **P2P audio** - Direct peer-to-peer, no server relay
- **Beautiful UI** - Dark glassmorphism with elegant animations
- **Elegant names** - Auto-assigned names like "Quiet Ember" or "Silver Drift"
- **Room-based** - Share a room code to connect
- **Visual feedback** - See who's speaking with glowing indicators

## Quick Start

### Development

1. **Start both servers:**
   ```bash
   # Terminal 1 - SvelteKit
   npm run dev
   
   # Terminal 2 - PartyKit (signaling)
   npm run dev:party
   ```

2. **Open in browser:** http://localhost:5173

### Deployment

1. **Login to PartyKit (Cloudflare):**
   ```bash
   npm run party:login
   ```

2. **Deploy PartyKit:**
   ```bash
   npm run party:deploy
   ```
   Note the URL (e.g., `lospeak.yourname.partykit.dev`)

3. **Create `.env` file:**
   ```
   VITE_PARTYKIT_HOST=lospeak.yourname.partykit.dev
   ```

4. **Deploy to Vercel:**
   - Push to GitHub
   - Import to Vercel
   - Add `VITE_PARTYKIT_HOST` environment variable

## Architecture

```
┌──────────────┐     WebSocket      ┌─────────────────┐
│   Browser    │◄──────────────────►│    PartyKit     │
│  (SvelteKit) │                    │   (Signaling)   │
└──────────────┘                    └─────────────────┘
       │                                    │
       │            WebRTC P2P              │
       └────────────────────────────────────┘
              Direct audio streams
```

## Tech Stack

- **Frontend**: Svelte 5, SvelteKit, TypeScript
- **Signaling**: PartyKit (Cloudflare Durable Objects)
- **Audio**: WebRTC with Opus codec
- **Styling**: CSS with dark glassmorphism

## License

MIT
