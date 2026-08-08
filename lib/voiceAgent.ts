export type AgentEvent = { type: string; [key: string]: unknown };

export interface VoiceAgentCallbacks {
  /** 0..1 amplitude of the agent's live speech, for orb reactivity. */
  onLevel(level: number): void;
  /** Raw JSON events from the agent (transcripts, turn state, etc). */
  onEvent?(event: AgentEvent): void;
  onError?(message: string): void;
}

const RELAY_URL =
  process.env.NEXT_PUBLIC_RELAY_URL ?? "ws://localhost:8787";

const PLAYBACK_SAMPLE_RATE = 24000;
const MAX_RECONNECTS = 3;

export class VoiceAgent {
  private ws: WebSocket | null = null;
  private micStream: MediaStream | null = null;
  private micContext: AudioContext | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private playContext: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private levelData: Uint8Array<ArrayBuffer> | null = null;
  private nextPlayTime = 0;
  private rafId = 0;
  private callbacks: VoiceAgentCallbacks;
  private stopped = false;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(callbacks: VoiceAgentCallbacks) {
    this.callbacks = callbacks;
  }

  async start(): Promise<void> {
    this.stopped = false;
    this.micStream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    });

    this.micContext = new AudioContext();
    await this.micContext.audioWorklet.addModule("/pcm-capture-worklet.js");
    const source = this.micContext.createMediaStreamSource(this.micStream);
    this.workletNode = new AudioWorkletNode(this.micContext, "pcm-capture-processor");
    source.connect(this.workletNode);

    this.playContext = new AudioContext({ sampleRate: PLAYBACK_SAMPLE_RATE });
    this.analyser = this.playContext.createAnalyser();
    this.analyser.fftSize = 256;
    this.analyser.connect(this.playContext.destination);
    this.levelData = new Uint8Array(this.analyser.frequencyBinCount);
    this.nextPlayTime = this.playContext.currentTime;

    this.tickLevel();
    this.connectWs();
  }

  private connectWs(): void {
    const ws = new WebSocket(RELAY_URL);
    ws.binaryType = "arraybuffer";
    this.ws = ws;

    ws.onopen = () => {
      this.reconnectAttempts = 0;
      this.workletNode!.port.onmessage = (e: MessageEvent<ArrayBuffer>) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(e.data);
      };
    };

    ws.onmessage = (e: MessageEvent) => {
      if (typeof e.data === "string") {
        try {
          this.callbacks.onEvent?.(JSON.parse(e.data) as AgentEvent);
        } catch {
          // ignore malformed control messages
        }
      } else {
        this.playPCM(e.data as ArrayBuffer);
      }
    };

    // onclose always fires after onerror for WebSocket, so reconnect/failure
    // handling lives there — onerror alone would double-report.
    ws.onerror = () => {};

    ws.onclose = () => {
      if (this.stopped) return;

      if (this.reconnectAttempts < MAX_RECONNECTS) {
        this.reconnectAttempts += 1;
        const delay = 500 * 2 ** (this.reconnectAttempts - 1);
        this.callbacks.onEvent?.({ type: "ClientReconnecting", attempt: this.reconnectAttempts });
        this.reconnectTimer = setTimeout(() => {
          if (!this.stopped) this.connectWs();
        }, delay);
      } else {
        this.callbacks.onError?.("RELAY DISCONNECTED");
      }
    };
  }

  private playPCM(buf: ArrayBuffer): void {
    if (!this.playContext || !this.analyser) return;
    const int16 = new Int16Array(buf);
    const float32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) float32[i] = int16[i] / 0x8000;

    const audioBuffer = this.playContext.createBuffer(
      1,
      float32.length,
      this.playContext.sampleRate,
    );
    audioBuffer.copyToChannel(float32, 0);

    const src = this.playContext.createBufferSource();
    src.buffer = audioBuffer;
    src.connect(this.analyser);

    const startAt = Math.max(this.nextPlayTime, this.playContext.currentTime);
    src.start(startAt);
    this.nextPlayTime = startAt + audioBuffer.duration;
  }

  private tickLevel = (): void => {
    if (this.analyser && this.levelData) {
      this.analyser.getByteTimeDomainData(this.levelData);
      let sumSq = 0;
      for (const v of this.levelData) {
        const centered = (v - 128) / 128;
        sumSq += centered * centered;
      }
      const rms = Math.sqrt(sumSq / this.levelData.length);
      this.callbacks.onLevel(Math.min(1, rms * 4));
    }
    this.rafId = requestAnimationFrame(this.tickLevel);
  };

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    cancelAnimationFrame(this.rafId);
    this.ws?.close();
    this.ws = null;
    this.workletNode?.disconnect();
    this.workletNode = null;
    this.micStream?.getTracks().forEach((t) => t.stop());
    this.micStream = null;
    void this.micContext?.close();
    this.micContext = null;
    void this.playContext?.close();
    this.playContext = null;
    this.analyser = null;
    this.callbacks.onLevel(0);
  }
}
