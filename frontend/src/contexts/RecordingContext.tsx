import { createContext, useState, useEffect, ReactNode } from "react";
import { toast } from "@/hooks/use-toast";

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

// Shape of GET /api/recordings/active's per-session entries — the backend's
// ground truth for what's actually recording (an ffmpeg process really
// running), independent of whatever this tab's local state believes.
interface BackendRecordingSession {
  session_id: string;
  kind: "raw" | "inference";
  camera_index: number;
  slot: number | null;
  filename: string;
  elapsed_seconds: number;
  paused: boolean;
}

const RECONCILE_INTERVAL_MS = 4000;

function labelFor(kind: "raw" | "inference", cameraIndex: number, slot: number | null): string {
  return kind === "raw" ? `Camera ${cameraIndex} — Raw` : `Camera ${(slot ?? cameraIndex + 1) - 1} — Inference`;
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

    // Then restore active sessions (best-effort — the reconciliation poll
    // below corrects this against the backend within a few seconds either
    // way, whether the process died while we were gone or is still running)
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

  // ── Reconcile against backend truth ───────────────────────────────────────
  // Local state only changes on Start/Stop/Pause/Resume responses — if an
  // ffmpeg process dies on its own (killed, disk full, camera drops), the UI
  // would otherwise keep showing "Recording…" with a happily incrementing
  // timer forever. Poll the backend's actual process list and reconcile:
  // sessions we think are running but the backend doesn't know about are
  // dead (toast an error, drop them); sessions the backend knows about that
  // we don't (e.g. localStorage was cleared, or another tab started one) are
  // adopted so the UI reflects reality instead of hiding them.
  useEffect(() => {
    let cancelled = false;

    const reconcile = async () => {
      let res: Response;
      try {
        res = await fetch("/api/recordings/active");
      } catch {
        return; // network hiccup — don't flag anything dead over a transient failure
      }
      if (!res.ok || cancelled) return;

      let backendSessions: BackendRecordingSession[];
      try {
        const data = await res.json();
        backendSessions = Array.isArray(data.sessions) ? data.sessions : [];
      } catch {
        return;
      }
      if (cancelled) return;

      const backendIds = new Set(backendSessions.map((s) => s.session_id));
      let died: ActiveRecording[] = [];

      setRecordingState((prev) => {
        died = prev.sessions.filter((s) => !backendIds.has(s.sessionId));
        const knownIds = new Set(prev.sessions.map((s) => s.sessionId));

        const survivors = prev.sessions
          .filter((s) => backendIds.has(s.sessionId))
          .map((s) => {
            const match = backendSessions.find((b) => b.session_id === s.sessionId)!;
            // Keep pause state in sync in case another tab paused/resumed it.
            if (match.paused && s.pausedAt === null) return { ...s, pausedAt: Date.now() };
            if (!match.paused && s.pausedAt !== null) return { ...s, pausedAt: null };
            return s;
          });

        const adopted: ActiveRecording[] = backendSessions
          .filter((s) => !knownIds.has(s.session_id))
          .map((s) => ({
            sessionId: s.session_id,
            kind: s.kind,
            cameraIndex: s.camera_index,
            slot: s.slot,
            label: labelFor(s.kind, s.camera_index, s.slot),
            filename: s.filename,
            startTime: Date.now() - s.elapsed_seconds * 1000,
            pausedAt: s.paused ? Date.now() : null,
          }));

        if (died.length === 0 && adopted.length === 0 &&
            survivors.length === prev.sessions.length &&
            survivors.every((s, i) => s === prev.sessions[i])) {
          return prev; // nothing changed — skip the re-render/localStorage write
        }

        const nextSessions = [...survivors, ...adopted];
        try {
          localStorage.setItem(RECORDING_STATE_KEY, JSON.stringify({ sessions: nextSessions }));
        } catch { /* storage quota — ignore */ }
        return { ...prev, sessions: nextSessions };
      });

      died.forEach((s) => {
        toast({
          variant: "destructive",
          title: "Recording stopped unexpectedly",
          description: `${s.label} (${s.filename}) is no longer recording — check disk space or camera connectivity.`,
        });
      });
    };

    reconcile();
    const interval = setInterval(reconcile, RECONCILE_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

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
