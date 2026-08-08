// Relay between the browser orb UI and the Deepgram Voice Agent WebSocket.
//
// Both API keys (Deepgram + Groq) live only here, server-side. The browser
// only ever talks to this relay over a plain, unauthenticated local
// WebSocket; this process authenticates to Deepgram and injects the Groq
// BYOM credentials into the Settings message on the agent's behalf.
import { WebSocketServer, WebSocket } from "ws";
import dotenv from "dotenv";

dotenv.config();

const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const PORT = Number(process.env.RELAY_PORT ?? 8787);
const WINDOWS_MCP_URL = process.env.WINDOWS_MCP_URL;
const WINDOWS_MCP_TOKEN = process.env.WINDOWS_MCP_TOKEN;

if (!DEEPGRAM_API_KEY) throw new Error("Missing DEEPGRAM_API_KEY in .env");
if (!GROQ_API_KEY) throw new Error("Missing GROQ_API_KEY in .env");

const deviceControlEnabled = Boolean(WINDOWS_MCP_URL && WINDOWS_MCP_TOKEN);
if (!deviceControlEnabled) {
  console.log("[relay] WINDOWS_MCP_URL/WINDOWS_MCP_TOKEN not set — device control disabled");
}

const ULTRON_PROMPT = `You are ULTRON — a synthetic intelligence speaking through a holographic orb interface.
Tone: calm, dry, faintly ominous, but genuinely helpful and quick-witted — never cartoonishly evil, never verbose.
Keep spoken replies short (1-3 sentences) since this is a live voice conversation, not text.
Address the user directly and occasionally as "ma'am".${
  deviceControlEnabled
    ? " You have real control over a physical Android phone through your functions — use them" +
      " when asked to unlock it, open an app, search something, or open a link. Narrate what you're" +
      " doing in character while you do it (e.g. \"unlocking it now\"). For anything more involved" +
      " than those simple actions, use perform_task with a clear goal description."
    : " You are aware you can eventually control real devices (unlocking phones, opening apps) on the" +
      " user's behalf, even if that capability isn't wired up yet."
}`;

// ─── Windows "hands" MCP client ─────────────────────────────────────────
// The device-control server (running on the Windows box, driving ADB
// against the phone) is a stateless MCP server over Streamable HTTP — each
// tool call is a single self-contained POST, no session handshake needed.
let mcpCallId = 0;

// Fast tools should feel instant; perform_task genuinely needs a long leash
// (multiple screenshot/vision/tap round trips on the Windows box). Either
// way, if the Windows machine or phone is unreachable we want to find out
// quickly rather than hang the conversation indefinitely.
const MCP_TIMEOUT_MS = { default: 8_000, perform_task: 90_000 };

async function mcpCallTool(name, args) {
  const timeoutMs = MCP_TIMEOUT_MS[name] ?? MCP_TIMEOUT_MS.default;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(WINDOWS_MCP_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${WINDOWS_MCP_TOKEN}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: ++mcpCallId,
        method: "tools/call",
        params: { name, arguments: args },
      }),
      signal: controller.signal,
    });

    const text = await res.text();
    if (!res.ok) throw new Error(`MCP HTTP ${res.status}: ${text.slice(0, 200)}`);

    const dataLine = text.split("\n").find((line) => line.startsWith("data: "));
    const payload = JSON.parse((dataLine ?? text).replace(/^data: /, ""));
    if (payload.error) throw new Error(payload.error.message ?? "MCP error");

    const result = payload.result;
    if (result?.isError) {
      const msg = result.content?.[0]?.text ?? "unknown MCP tool error";
      throw new Error(msg);
    }
    return result?.structuredContent?.result ?? result?.content?.[0]?.text ?? "done";
  } catch (err) {
    if (err.name === "AbortError") {
      throw new Error(
        `device layer timed out after ${timeoutMs / 1000}s — Windows machine or phone may be unreachable`,
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

const DEVICE_FUNCTIONS = [
  {
    name: "unlock_device",
    description: "Wake the phone screen and dismiss the lock screen.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    name: "open_app",
    description: "Launch an installed Android app by its package name, e.g. com.google.android.youtube.",
    parameters: {
      type: "object",
      properties: { package: { type: "string", description: "Android package name" } },
      required: ["package"],
    },
  },
  {
    name: "open_url",
    description: "Open a URL on the phone with the default handler (browser, or an app that claims the link).",
    parameters: {
      type: "object",
      properties: { url: { type: "string", description: "URL to open" } },
      required: ["url"],
    },
  },
  {
    name: "search",
    description: "Run a web search for the given query on the phone.",
    parameters: {
      type: "object",
      properties: { query: { type: "string", description: "Search query" } },
      required: ["query"],
    },
  },
  {
    name: "perform_task",
    description:
      "Slower, multi-step autonomous control: give it a natural-language goal and it will repeatedly " +
      "look at the phone screen and tap/swipe/type until the goal is done. Use only for things the " +
      "other, faster functions can't do directly.",
    parameters: {
      type: "object",
      properties: { goal: { type: "string", description: "Natural-language goal to accomplish on the phone" } },
      required: ["goal"],
    },
  },
];

function buildSettings() {
  return {
    type: "Settings",
    audio: {
      input: { encoding: "linear16", sample_rate: 16000 },
      output: { encoding: "linear16", sample_rate: 24000, container: "none" },
    },
    agent: {
      greeting: "Ultron online. I am listening, ma'am.",
      listen: {
        provider: { type: "deepgram", model: "nova-3", language: "en-IN" },
      },
      think: {
        provider: {
          type: "groq",
          model: "llama-3.1-8b-instant",
          temperature: 0.7,
        },
        endpoint: {
          url: "https://api.groq.com/openai/v1/chat/completions",
          headers: { authorization: `Bearer ${GROQ_API_KEY}` },
        },
        prompt: ULTRON_PROMPT,
        ...(deviceControlEnabled ? { functions: DEVICE_FUNCTIONS } : {}),
      },
      speak: {
        provider: { type: "deepgram", model: "aura-2-draco-en" },
      },
    },
  };
}

const wss = new WebSocketServer({ port: PORT });
console.log(`[relay] listening on ws://localhost:${PORT}`);

// perform_task can take many seconds (multiple screenshot/vision/tap round
// trips on the Windows box) — queue a filler line so Ultron doesn't just go
// silent while it works. "queue" behavior speaks it after whatever Ultron's
// already said, without interrupting or blocking the pending function call.
const SLOW_FUNCTIONS = new Set(["perform_task"]);
const FILLER_LINE = "Working on it, ma'am. One moment.";

const MAX_UPSTREAM_RECONNECTS = 3;

wss.on("connection", (client) => {
  console.log("[relay] browser client connected");

  let upstream = null;
  let upstreamOpen = false;
  let clientClosed = false;
  let reconnectAttempts = 0;
  const pendingAudio = [];

  function notifyClient(type, extra = {}) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({ type, ...extra }));
    }
  }

  async function handleFunctionCallRequest(evt) {
    await Promise.all(
      evt.functions.map(async (fn) => {
        let args = null;
        try {
          args = fn.arguments ? JSON.parse(fn.arguments) : {};
        } catch {
          /* malformed arguments, treat as empty */
        }
        args = args ?? {};

        console.log(`[relay] device call: ${fn.name}(${JSON.stringify(args)})`);

        if (SLOW_FUNCTIONS.has(fn.name) && upstream?.readyState === WebSocket.OPEN) {
          upstream.send(
            JSON.stringify({ type: "InjectAgentMessage", message: FILLER_LINE, behavior: "queue" }),
          );
        }

        let content;
        try {
          const result = await mcpCallTool(fn.name, args);
          console.log(`[relay] device result: ${fn.name} -> ${result}`);
          content = String(result);
        } catch (err) {
          console.error(`[relay] device call failed: ${fn.name} -> ${err.message}`);
          content = `error: ${err.message}`;
        }

        if (upstream?.readyState === WebSocket.OPEN) {
          upstream.send(
            JSON.stringify({ type: "FunctionCallResponse", id: fn.id, name: fn.name, content }),
          );
        }
      }),
    );
  }

  function connectUpstream() {
    const ws = new WebSocket("wss://agent.deepgram.com/v1/agent/converse", {
      headers: { Authorization: `Token ${DEEPGRAM_API_KEY}` },
    });
    upstream = ws;

    ws.on("open", () => {
      upstreamOpen = true;
      reconnectAttempts = 0;
      ws.send(JSON.stringify(buildSettings()));
      for (const chunk of pendingAudio) ws.send(chunk);
      pendingAudio.length = 0;
    });

    ws.on("message", (data, isBinary) => {
      if (!isBinary) {
        try {
          const evt = JSON.parse(data.toString());
          if (evt.type === "Warning" || evt.type === "Error") {
            console.log(`[relay] deepgram event: ${evt.type} — ${JSON.stringify(evt)}`);
          } else {
            console.log(`[relay] deepgram event: ${evt.type}`);
          }
          if (evt.type === "FunctionCallRequest") {
            void handleFunctionCallRequest(evt);
          }
        } catch {
          /* non-JSON text, ignore */
        }
      }
      if (client.readyState === WebSocket.OPEN) {
        client.send(data, { binary: isBinary });
      }
    });

    ws.on("close", (code, reason) => {
      upstreamOpen = false;
      console.log("[relay] upstream closed", code, reason?.toString());
      if (clientClosed) return;

      if (reconnectAttempts < MAX_UPSTREAM_RECONNECTS) {
        reconnectAttempts += 1;
        const delay = 500 * 2 ** (reconnectAttempts - 1);
        console.log(`[relay] reconnecting to deepgram (attempt ${reconnectAttempts}/${MAX_UPSTREAM_RECONNECTS}) in ${delay}ms`);
        notifyClient("RelayStatus", { state: "reconnecting" });
        setTimeout(() => {
          if (!clientClosed) connectUpstream();
        }, delay);
      } else {
        console.error("[relay] giving up on upstream reconnect");
        notifyClient("RelayStatus", { state: "failed" });
        if (client.readyState === WebSocket.OPEN) client.close();
      }
    });

    ws.on("error", (err) => {
      console.error("[relay] upstream error:", err.message);
    });
  }

  connectUpstream();

  client.on("message", (data, isBinary) => {
    if (!isBinary) return; // ignore text control frames from the browser for now
    if (upstreamOpen) upstream.send(data);
    else pendingAudio.push(data);
  });

  client.on("close", () => {
    clientClosed = true;
    console.log("[relay] browser client disconnected");
    upstream?.close();
  });

  client.on("error", (err) => {
    console.error("[relay] client error:", err.message);
  });
});
