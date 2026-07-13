import { createContext, useState, useEffect, ReactNode } from "react";

export interface ActiveRecording {
  sessionId: string;
  kind: "raw" | "inference";
  cameraIndex: number;
  slot: number | null;       // only meaningful for kind === "inference"
  label: string;             // e.g. "Camera 0 — Raw" / "Camera 1 — Inference"
  filename: string;
  startTime: number;         // ms epoch
  pausedAt: number | null;   // ms epoch, null when not paused
}

export interface RecordingState {
  // Multiple recordings can run at once (raw + inference, several cameras).
  sessions: ActiveRecording[];
  savePath: string;
}

interface RecordingContextType {
  recording: RecordingState;
  setRecording: (state: RecordingState | ((prev: RecordingState) => RecordingState)) => void;
  elapsedSeconds: (session: ActiveRecording) => number;
}

export const RecordingContext = createContext<RecordingContextType | undefined>(undefined);

const RECORDING_STATE_KEY = "recordingState";
const RECORDING_SAVE_PATH_KEY = "recordingSavePath";

export function RecordingProvider({ children }: { children: ReactNode }) {
  const [recording, setRecordingState] = useState<RecordingState>(() => {
    // Load save path first — this should persist across sessions
    let savePath = "";
    try {
      const saved = localStorage.getItem(RECORDING_SAVE_PATH_KEY);
      savePath = saved || "";
    } catch { /* noop */ }

    // Then restore active sessions (best-effort — if the backend process
    // restarted, these will simply show as stopped/gone next poll)
    try {
      const saved = localStorage.getItem(RECORDING_STATE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        return {
          sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
          savePath,
        };
      }
    } catch (err) {
      console.error("Failed to load recording state from localStorage:", err);
    }

    return { sessions: [], savePath };
  });

  // ── Callback wrapper to persist state updates ─────────────────────────────
  const setRecording = (
    updater: RecordingState | ((prev: RecordingState) => RecordingState)
  ) => {
    setRecordingState((prev) => {
      const next = typeof updater === "function" ? updater(prev) : updater;

      try {
        localStorage.setItem(
          RECORDING_STATE_KEY,
          JSON.stringify({ sessions: next.sessions })
        );
      } catch { /* storage quota — ignore */ }

      if (next.savePath !== prev.savePath) {
        try {
          localStorage.setItem(RECORDING_SAVE_PATH_KEY, next.savePath);
          // Notify other tabs/listeners
          window.dispatchEvent(
            new CustomEvent("recordingPathChanged", { detail: next.savePath })
          );
        } catch { /* storage quota — ignore */ }
      }

      return next;
    });
  };

  // ── Timer: forces a re-render every second so elapsedSeconds() below stays
  // live, without each consumer needing its own interval ────────────────────
  const [, setTick] = useState(0);
  useEffect(() => {
    if (recording.sessions.length === 0) return;
    const timer = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(timer);
  }, [recording.sessions.length]);

  const elapsedSeconds = (session: ActiveRecording): number => {
    const end = session.pausedAt ?? Date.now();
    return Math.max(0, Math.floor((end - session.startTime) / 1000));
  };

  return (
    <RecordingContext.Provider
      value={{
        recording,
        setRecording,
        elapsedSeconds,
      }}
    >
      {children}
    </RecordingContext.Provider>
  );
}
