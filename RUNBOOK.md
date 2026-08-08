# ULTRON — Run Book

Quick reference for starting, using, and debugging the orb + voice agent on this Mac.

## 1. Start everything

One terminal, from the project folder:

```bash
cd /Users/gayathri/Desktop/ultron
npm run dev:all
```

This starts both processes together:
- **Orb UI** (Next.js) → http://localhost:3000
- **Voice relay** (Node) → ws://localhost:8787 (talks to Deepgram + Groq, keeps both API keys server-side)

If you'd rather run them separately (e.g. to restart just one after an edit):

```bash
npm run dev      # orb UI only
npm run relay    # relay only
```

## 2. Open it

Go to **http://localhost:3000** in a real browser (Safari/Chrome — not a headless/sandboxed one, it needs real camera + mic access).

## 3. Controls

| Action | How |
|---|---|
| Spin the orb | Drag with mouse, **or** pinch one hand + move (after enabling gestures) |
| Zoom | Scroll wheel, **or** pinch both hands + spread/close (after enabling gestures), **or** `+`/`-` keys |
| Reset view | `R` key or **RESET** button |
| Turn on hand gestures | Click **GESTURES OFF** button or press `G` — grant camera access when asked |
| Talk to Ultron | Click **TALK TO ULTRON** button or press `V` — grant mic access when asked |

**Status readout** (next to the talk button, once connected):
- `CONNECTING…` — negotiating with Deepgram
- `ULTRON: CONNECTED` / `READY` — session live, waiting for you to speak
- `ULTRON: LISTENING` — it heard you start talking
- `ULTRON: THINKING` — Groq is generating a reply
- `ULTRON: SPEAKING` — playing back its voice (orb should visibly pulse)
- `ULTRON: STANDBY` — back to idle after speaking
- `ULTRON: RECONNECTING…` — the connection to Deepgram or the relay dropped and it's automatically retrying (up to 3 attempts with backoff). Usually resolves itself within a few seconds; no action needed.

Click **TALK TO ULTRON** again (or press `V`) to hang up.

**Device functions** (once the Windows MCP server is configured — see §8): just ask naturally, e.g. "unlock my phone," "open YouTube," "search for X," or "play a video on YouTube" (the last one uses the slower `perform_task` agentic loop — Ultron will say a filler line like "Working on it, creator" while it works, since that can take 10-30+ seconds).

## 4. If something's wrong

**"CAMERA ACCESS DENIED" or "MIC ACCESS DENIED"** — browser permission was blocked. Check the address bar's site-permission icon and allow camera/mic, then retry.

**Voice button says "CONNECTING…" forever, or errors immediately** — the relay probably isn't running. Check:

```bash
lsof -iTCP:8787 -sTCP:LISTEN -P   # should show a node process
tail -50 /tmp/ultron-relay.log    # see what it's doing
```

**Ultron stops responding mid-conversation** — as of now, transient drops (Groq rate limits, brief network hiccups) should **self-heal**: the relay auto-reconnects to Deepgram (up to 3 attempts, backoff), and the browser auto-reconnects to the relay the same way. You'll briefly see `RECONNECTING…` in the status readout. If it doesn't recover within ~10-15 seconds, check the real reason logged for every `Warning`/`Error` event from Deepgram:

```bash
tail -100 /tmp/ultron-relay.log
```

Look for a line like `Rate limit reached ... tokens per day (TPD)`. If you see that repeatedly, either wait for the quota to reset (it's a rolling window, usually minutes) or swap `server/agentRelay.mjs`'s `agent.think.provider.model` to a model with more daily headroom (currently set to `llama-3.1-8b-instant`, which has the highest free-tier budget of Groq's common models).

**A device command ("unlock my phone", etc.) fails or times out** — check:

```bash
tail -50 /tmp/ultron-relay.log   # look for "[relay] device call:" / "device result:" / "device call failed:"
```

Fast tools (`unlock_device`, `open_app`, `open_url`, `search`) time out after 8s; `perform_task` after 90s. A timeout almost always means the Windows machine is asleep/off, off the LAN, or the phone got unplugged — check that machine directly. Reachability check from the Mac:

```bash
curl -s -o /dev/null -w "HTTP %{http_code}\n" --max-time 5 http://<windows-lan-ip>:8765/mcp
```
(`401` = reachable and healthy, just needs the auth header — that's expected for a bare GET/POST without a token.)

**After editing `server/agentRelay.mjs`**, always restart the relay — it doesn't hot-reload like the Next.js UI does:

```bash
pkill -f "node server/agentRelay.mjs"
npm run relay
```

## 5. Stopping everything

`Ctrl-C` in the terminal running `dev:all` (or `pkill -f "node server/agentRelay.mjs"` and `pkill -f "next dev"` if they're detached in the background).

## 6. Where things live

- [components/JarvisOrb.tsx](components/JarvisOrb.tsx) — main UI: buttons, keyboard shortcuts, status display
- [lib/orbScene.ts](lib/orbScene.ts) — the Three.js orb itself, incl. voice-reactive glow
- [lib/handTracker.ts](lib/handTracker.ts) — MediaPipe pinch-gesture detection
- [lib/voiceAgent.ts](lib/voiceAgent.ts) — browser-side mic capture, playback, and auto-reconnect
- [server/agentRelay.mjs](server/agentRelay.mjs) — the relay: Deepgram connection + auto-reconnect, Groq config, **Ultron's personality prompt**, device-function wiring to the Windows MCP server
- `.env` — `DEEPGRAM_API_KEY`, `GROQ_API_KEY`, `WINDOWS_MCP_URL`, `WINDOWS_MCP_TOKEN` (never commit this — already gitignored)

## 7. Device control ("hands")

A separate Python MCP server runs on the Windows Pavilion, driving ADB against the connected Moto phone. It exposes 5 tools (`unlock_device`, `open_app`, `open_url`, `search`, `perform_task`) which `agentRelay.mjs` calls when Ultron decides to use them mid-conversation — no code on this Mac talks to ADB directly.

If that Windows server isn't running or `.env` is missing `WINDOWS_MCP_URL`/`WINDOWS_MCP_TOKEN`, device control is simply disabled — voice still works fine on its own (check the relay's startup log for `device control disabled` to confirm which mode it's in).

## 8. What's not built yet

Phase 5 (polish, optional) — supporting more than one Android device, more scripted device tools (volume, specific shortcuts), and further personality/voice tuning based on real usage.
