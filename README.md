# ULTRON

A holographic orb you control with bare-hand webcam gestures, wired to a real-time voice agent with an Ultron personality — and, optionally, a layer that lets it control a physical Android device while you watch.

<!-- TODO: add a screenshot/GIF of this build (voice + orb reacting, or a device-control clip) -->

## Stack

- **Orb UI**: Next.js, Three.js, MediaPipe HandLandmarker (webcam pinch gestures)
- **Voice**: Deepgram Voice Agent API (STT + TTS) with Groq as the LLM brain
- **Device control** (optional): a separate MCP server driving ADB against an Android phone

## Setup

Prerequisites: Node.js, a [Deepgram](https://deepgram.com) API key, a [Groq](https://console.groq.com) API key.

```bash
npm install
cp .env.example .env   # then fill in DEEPGRAM_API_KEY and GROQ_API_KEY
npm run dev:all        # runs the orb UI (:3000) and the voice relay (:8787) together
```

Open [http://localhost:3000](http://localhost:3000). Everything works with just those two keys — device control is a fully optional third piece (see below).

## Controls

| Input | Action |
| --- | --- |
| Drag | Spin the orb |
| Scroll | Zoom in / out |
| `R` | Reset the view |
| `+` / `−` | Zoom in / out |
| Click **GESTURES OFF** or press `G` | Toggle hand-gesture control (grant camera access) |
| Click **TALK TO ULTRON** or press `V` | Start/stop a voice conversation (grant mic access) |

**Hand gestures** (once enabled): pinch thumb + index on one hand and move it to spin the orb; pinch with both hands and spread apart / bring together to zoom.

**Status readout** (once talking): `LISTENING` → `THINKING` → `SPEAKING` → `STANDBY`, with a `RECONNECTING…` state if the connection briefly drops (it retries automatically).

## Device control (optional)

If you want Ultron to actually control an Android device (unlock it, open apps, search, or run multi-step tasks via an agentic screenshot-and-tap loop), run a compatible MCP server that exposes these tools — `unlock_device`, `open_app`, `open_url`, `search`, `perform_task` — and point `WINDOWS_MCP_URL` / `WINDOWS_MCP_TOKEN` in `.env` at it. Leave both unset to run voice-only.

## How it works

- `lib/orbScene.ts` — the Three.js scene (wireframe shells, spiral core, particles, bloom/chromatic-aberration post-processing), with a voice-reactive glow hook
- `lib/handTracker.ts` — MediaPipe hand-gesture detection
- `lib/voiceAgent.ts` — browser-side mic capture, audio playback, and auto-reconnect
- `components/JarvisOrb.tsx` — the HUD and glue between the scene, tracker, and voice agent
- `server/agentRelay.mjs` — Node relay: authenticates to Deepgram, injects the Groq config, holds Ultron's persona prompt, and bridges function calls to the device-control MCP server

## Credits

The orb UI — the Three.js scene and MediaPipe hand-gesture control — is based on [ultron-by-sagar-builds](https://github.com/SAGAR-TAMANG/ultron-by-sagar-builds) by Sagar Tamang, MIT licensed. Everything else in this repo — the Deepgram/Groq voice agent, Ultron's persona, the auto-reconnect/reliability layer, and the Android device-control integration — was built for this project.

## License

MIT
