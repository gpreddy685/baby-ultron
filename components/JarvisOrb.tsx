"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createOrbScene, type OrbSceneApi } from "@/lib/orbScene";
import { HandTracker, type TrackerStatus } from "@/lib/handTracker";
import { VoiceAgent, type AgentEvent } from "@/lib/voiceAgent";

type CameraState = "off" | "starting" | "on" | "error";
type VoiceState = "off" | "starting" | "on" | "error";

const MODE_LABEL: Record<TrackerStatus["mode"], string> = {
  idle: "STANDBY",
  spin: "SPIN",
  zoom: "ZOOM",
};

export default function JarvisOrb() {
  const containerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const sceneRef = useRef<OrbSceneApi | null>(null);
  const trackerRef = useRef<HandTracker | null>(null);
  const voiceRef = useRef<VoiceAgent | null>(null);

  const [camera, setCamera] = useState<CameraState>("off");
  const [status, setStatus] = useState<TrackerStatus>({ hands: 0, mode: "idle" });
  const [error, setError] = useState<string | null>(null);

  const [voice, setVoice] = useState<VoiceState>("off");
  const [voiceLabel, setVoiceLabel] = useState<string>("STANDBY");
  const [voiceError, setVoiceError] = useState<string | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const scene = createOrbScene(container);
    sceneRef.current = scene;
    return () => {
      trackerRef.current?.stop();
      trackerRef.current = null;
      voiceRef.current?.stop();
      voiceRef.current = null;
      scene.dispose();
      sceneRef.current = null;
    };
  }, []);

  const VOICE_LABELS: Partial<Record<string, string>> = {
    Welcome: "CONNECTED",
    SettingsApplied: "READY",
    UserStartedSpeaking: "LISTENING",
    AgentThinking: "THINKING",
    AgentStartedSpeaking: "SPEAKING",
    AgentAudioDone: "STANDBY",
    ClientReconnecting: "RECONNECTING…",
  };

  const stopVoice = useCallback(() => {
    voiceRef.current?.stop();
    voiceRef.current = null;
    sceneRef.current?.setAudioLevel(0);
    setVoice("off");
    setVoiceLabel("STANDBY");
  }, []);

  const startVoice = useCallback(async () => {
    if (voiceRef.current) return;
    setVoice("starting");
    setVoiceError(null);

    const agent = new VoiceAgent({
      onLevel: (level) => sceneRef.current?.setAudioLevel(level),
      onEvent: (evt: AgentEvent) => {
        if (evt.type === "RelayStatus") {
          if (evt.state === "reconnecting") setVoiceLabel("RECONNECTING…");
          return;
        }
        const label = VOICE_LABELS[evt.type];
        if (label) setVoiceLabel(label);
        if (evt.type === "Welcome") setVoice("on");
      },
      onError: (message) => {
        setVoiceError(message);
        setVoice("error");
        voiceRef.current = null;
      },
    });
    voiceRef.current = agent;

    try {
      await agent.start();
    } catch {
      voiceRef.current = null;
      agent.stop();
      setVoice("error");
      setVoiceError("MIC ACCESS DENIED");
    }
  }, []);

  const toggleVoice = useCallback(() => {
    if (voiceRef.current) stopVoice();
    else void startVoice();
  }, [startVoice, stopVoice]);

  const stopGestures = useCallback(() => {
    trackerRef.current?.stop();
    trackerRef.current = null;
    setCamera("off");
    setStatus({ hands: 0, mode: "idle" });
  }, []);

  const startGestures = useCallback(async () => {
    const video = videoRef.current;
    const overlay = overlayRef.current;
    if (!video || !overlay || trackerRef.current) return;

    setCamera("starting");
    setError(null);

    const tracker = new HandTracker(video, overlay, {
      onRotate: (dt, dp) => sceneRef.current?.rotateBy(dt, dp),
      onZoom: (factor) => sceneRef.current?.zoomBy(factor),
      onStatus: setStatus,
    });
    trackerRef.current = tracker;

    try {
      await tracker.start();
      setCamera("on");
    } catch (err) {
      trackerRef.current = null;
      tracker.stop();
      setCamera("error");
      setError(
        err instanceof DOMException && err.name === "NotAllowedError"
          ? "CAMERA ACCESS DENIED"
          : "TRACKING INIT FAILED",
      );
    }
  }, []);

  const toggleGestures = useCallback(() => {
    if (trackerRef.current) stopGestures();
    else void startGestures();
  }, [startGestures, stopGestures]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      switch (e.key) {
        case "+":
        case "=":
          sceneRef.current?.zoomIn();
          break;
        case "-":
        case "_":
          sceneRef.current?.zoomOut();
          break;
        case "r":
        case "R":
          sceneRef.current?.resetView();
          break;
        case "g":
        case "G":
          toggleGestures();
          break;
        case "v":
        case "V":
          toggleVoice();
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleGestures, toggleVoice]);

  const cameraOn = camera === "on";
  const voiceOn = voice === "on" || voice === "starting";

  return (
    <>
      <div ref={containerRef} className="orb-root" />

      <div className="overlay-vignette" />
      <div className="overlay-grain" />
      <div className="overlay-scanlines" />

      <div className="hud hud-title">U.L.T.R.O.N.</div>

      <div className="hud hud-hint">
        <div>
          <span className="key">DRAG</span> spin&nbsp;&nbsp;
          <span className="key">SCROLL</span> zoom
        </div>
        {cameraOn ? (
          <div>
            <span className="key">PINCH + MOVE</span> spin&nbsp;&nbsp;
            <span className="key">PINCH BOTH HANDS ± SPREAD</span> zoom
          </div>
        ) : (
          <div>
            <span className="key">G</span> hand gestures&nbsp;&nbsp;
            <span className="key">V</span> talk to ultron&nbsp;&nbsp;
            <span className="key">R</span> reset&nbsp;&nbsp;
            <span className="key">+/−</span> zoom
          </div>
        )}
      </div>

      <div className="hud hud-controls">
        <div className={`camera-panel${cameraOn ? " visible" : ""}`}>
          {/* Mirrored preview so it behaves like a mirror */}
          <video ref={videoRef} muted playsInline className="camera-video" />
          <canvas ref={overlayRef} width={208} height={156} className="camera-overlay" />
          <div className="camera-status">
            {status.hands > 0
              ? `${status.hands} HAND${status.hands > 1 ? "S" : ""} · ${MODE_LABEL[status.mode]}`
              : "SHOW HANDS"}
          </div>
        </div>

        {error && <div className="hud-error">{error}</div>}
        {voiceError && <div className="hud-error">{voiceError}</div>}

        <div className="hud-row">
          <button
            type="button"
            className="hud-btn"
            aria-pressed={cameraOn}
            onClick={toggleGestures}
            disabled={camera === "starting"}
          >
            {camera === "starting" ? "INITIALIZING…" : cameraOn ? "GESTURES ON" : "GESTURES OFF"}
          </button>
        </div>
        <div className="hud-row">
          <button
            type="button"
            className="hud-btn"
            aria-pressed={voiceOn}
            onClick={toggleVoice}
            disabled={voice === "starting"}
          >
            {voice === "starting"
              ? "CONNECTING…"
              : voiceOn
                ? `ULTRON: ${voiceLabel}`
                : "TALK TO ULTRON"}
          </button>
        </div>
        <div className="hud-row">
          <button type="button" className="hud-btn" onClick={() => sceneRef.current?.zoomIn()} aria-label="Zoom in">
            +
          </button>
          <button type="button" className="hud-btn" onClick={() => sceneRef.current?.zoomOut()} aria-label="Zoom out">
            −
          </button>
          <button type="button" className="hud-btn" onClick={() => sceneRef.current?.resetView()}>
            RESET
          </button>
        </div>
      </div>
    </>
  );
}
