import { createContext, useState, useEffect, ReactNode, useRef } from "react";

export interface RecordingState {
  sessionId: string | null;
  isRecording: boolean;
  isPaused: boolean;
  selectedSlot: string | null;
  recordingStartTime: number | null; // Unix timestamp when recording started
  recordingPausedAt: number | null; // Unix timestamp when paused (for pause duration calculation)
  savePath: string;
}

interface RecordingContextType {
  recording: RecordingState;
  setRecording: (state: RecordingState | ((prev: RecordingState) => RecordingState)) => void;
  recordingTime: number; // Calculated elapsed seconds from recordingStartTime
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

    // Then restore recording state
    try {
      const saved = localStorage.getItem(RECORDING_STATE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        return {
          sessionId: parsed.sessionId || null,
          isRecording: parsed.isRecording ?? false,
          isPaused: parsed.isPaused ?? false,
          selectedSlot: parsed.selectedSlot || null,
          recordingStartTime: parsed.recordingStartTime || null,
          recordingPausedAt: parsed.recordingPausedAt || null,
          savePath,
        };
      }
    } catch (err) {
      console.error("Failed to load recording state from localStorage:", err);
    }

    return {
      sessionId: null,
      isRecording: false,
      isPaused: false,
      selectedSlot: null,
      recordingStartTime: null,
      recordingPausedAt: null,
      savePath,
    };
  });

  // ── Callback wrapper to persist state updates ─────────────────────────────
  const setRecording = (
    updater: RecordingState | ((prev: RecordingState) => RecordingState)
  ) => {
    setRecordingState((prev) => {
      const next = typeof updater === "function" ? updater(prev) : updater;

      // Persist to localStorage (excluding savePath which we handle separately)
      try {
        localStorage.setItem(
          RECORDING_STATE_KEY,
          JSON.stringify({
            sessionId: next.sessionId,
            isRecording: next.isRecording,
            isPaused: next.isPaused,
            selectedSlot: next.selectedSlot,
            recordingStartTime: next.recordingStartTime,
            recordingPausedAt: next.recordingPausedAt,
          })
        );
      } catch { /* storage quota — ignore */ }

      // Also update savePath if it changed
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

  // ── Calculate elapsed recording time from startTime ────────────────────────
  const [recordingTime, setRecordingTime] = useState(0);
  const recordingStartTimeRef = useRef<number | null>(null);
  const recordingPausedAtRef = useRef<number | null>(null);

  useEffect(() => {
    recordingStartTimeRef.current = recording.recordingStartTime;
    recordingPausedAtRef.current = recording.recordingPausedAt;
  }, [recording.recordingStartTime, recording.recordingPausedAt]);

  // ── Timer: runs globally, not tied to component lifecycle ──────────────────
  useEffect(() => {
    // Not recording at all — reset
    if (!recording.isRecording) {
      setRecordingTime(0);
      return;
    }

    // Calculate initial elapsed time
    let elapsed = 0;
    if (recordingStartTimeRef.current) {
      if (recording.isPaused && recordingPausedAtRef.current) {
        // Show time up to pause
        elapsed = Math.floor((recordingPausedAtRef.current - recordingStartTimeRef.current) / 1000);
      } else {
        // Show time from start to now
        elapsed = Math.floor((Date.now() - recordingStartTimeRef.current) / 1000);
      }
      setRecordingTime(Math.max(0, elapsed));
    }

    // If paused, don't update timer (keep the paused time showing)
    if (recording.isPaused) {
      return;
    }

    // Update every second while recording and not paused
    const timer = setInterval(() => {
      if (recordingStartTimeRef.current) {
        const newElapsed = Math.floor(
          (Date.now() - recordingStartTimeRef.current) / 1000
        );
        setRecordingTime(Math.max(0, newElapsed));
      }
    }, 1000);

    return () => clearInterval(timer);
  }, [recording.isRecording, recording.isPaused]);



  return (
    <RecordingContext.Provider
      value={{
        recording,
        setRecording,
        recordingTime,
      }}
    >
      {children}
    </RecordingContext.Provider>
  );
}
