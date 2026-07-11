import { createContext, useState, useEffect, ReactNode } from "react";

export interface StreamState {
  sourceType: "RTSP" | "USB" | "Video File" | null;
  sourceValue: string | null;
  isStreaming: boolean;
  modelCount: number;
  showAnnotated: boolean;
  sessionToken: string; // unique token per stream session, force hls.js reload on new session
}

interface StreamContextType {
  stream: StreamState;
  setStream: (state: StreamState | ((prev: StreamState) => StreamState)) => void;
  activeSlots: number;
}

export const StreamContext = createContext<StreamContextType | undefined>(undefined);

const STREAM_SOURCE_KEY = "streamSource";

export function StreamProvider({ children }: { children: ReactNode }) {
  const [stream, setStreamState] = useState<StreamState>(() => {
    // Restore whatever source the user last picked — but never trust the
    // in-memory isStreaming flag across a refresh; the backend check below
    // will correct it.
    try {
      const saved = localStorage.getItem(STREAM_SOURCE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        return {
          sourceType: parsed.sourceType || null,
          sourceValue: parsed.sourceValue || null,
          isStreaming: false,   // corrected by the mount check below
          modelCount: 0,
          showAnnotated: false,
          sessionToken: "",
        };
      }
    } catch (err) {
      console.error("Failed to load stream source from localStorage:", err);
    }
    return { sourceType: null, sourceValue: null, isStreaming: false, modelCount: 0, showAnnotated: false, sessionToken: "" };
  });

  const [previousModelCount, setPreviousModelCount] = useState(0);

  // ── On mount: ask the backend if a stream is already running ─────────────
  // This is the fix for "page refresh loses isStreaming while FFmpeg keeps
  // running on the backend".  We call both endpoints in parallel:
  //   /api/stream        → tells us whether any slot is active (count > 0)
  //   /api/stream/status → gives us source_type / source_value for slot 1
  // so the UI can reconstruct the full streaming view immediately.
  useEffect(() => {
    const restoreStreamState = async () => {
      try {
        const [streamRes, statusRes] = await Promise.all([
          fetch("/api/stream"),
          fetch("/api/stream/status"),
        ]);
        if (!streamRes.ok) return;

        const streamData = await streamRes.json();
        const isActive: boolean = (streamData.count ?? 0) > 0;
        if (!isActive) return;   // nothing running — leave isStreaming: false

        // Recover the source that slot 1 is currently using
        let sourceType: string | null = null;
        let sourceValue: string | null = null;
        if (statusRes.ok) {
          const statusData = await statusRes.json();
          const slot1 = statusData.slots?.[1];
          if (slot1?.running) {
            sourceType = slot1.source_type ?? null;
            sourceValue = slot1.source_value ?? null;
          }
        }

        setStreamState((prev) => ({
          ...prev,
          isStreaming: true,
          sessionToken: Math.random().toString(36).substring(2),
          // Prefer the live backend value; fall back to what localStorage had
          sourceType: (sourceType as StreamState["sourceType"]) ?? prev.sourceType,
          sourceValue: sourceValue ?? prev.sourceValue,
        }));
      } catch (err) {
        // Non-fatal — user just won't see the live view automatically restored
        console.debug("Stream state restore check failed:", err);
      }
    };

    restoreStreamState();
  }, []); // run exactly once on mount

  // ── Persist source selection to localStorage ──────────────────────────────
  useEffect(() => {
    localStorage.setItem(
      STREAM_SOURCE_KEY,
      JSON.stringify({
        sourceType: stream.sourceType,
        sourceValue: stream.sourceValue,
      })
    );
  }, [stream.sourceType, stream.sourceValue]);

  // ── Poll model count every 2 s ────────────────────────────────────────────
  useEffect(() => {
    const loadModelCount = async () => {
      try {
        const res = await fetch("/api/models/list");
        if (res.ok) {
          const data = await res.json();
          const newModelCount = data.models.length;
          setStreamState((prev) => {
            const next = { ...prev, modelCount: newModelCount };
            if (newModelCount > 0 && previousModelCount === 0) next.showAnnotated = true;
            else if (newModelCount === 0) next.showAnnotated = false;
            setPreviousModelCount(newModelCount);
            return next;
          });
        }
      } catch (err) {
        console.error("Failed to load models:", err);
      }
    };
    loadModelCount();
    const interval = setInterval(loadModelCount, 2000);
    return () => clearInterval(interval);
  }, [previousModelCount]);

  // ── Verify stream still active every 100 s ────────────────────────────────
  useEffect(() => {
    const verifyStreamState = async () => {
      if (!stream.isStreaming) return;
      try {
        const res = await fetch("/api/stream");
        if (!res.ok) return;
        const data = await res.json();
        const anySlotActive = Array.isArray(data.streams) && data.streams.length > 0;

        if (!anySlotActive) {
          for (const slot of [2, 3, 4]) {
            try {
              const inf = await fetch(`/api/stream/slot/${slot}/index.m3u8`);
              if (inf.ok) return;
            } catch { /* ignore */ }
          }
          console.warn("No active stream entries found — clearing isStreaming");
          setStreamState((prev) => ({ ...prev, isStreaming: false, sessionToken: "" }));
        }
      } catch (err) {
        console.debug("Stream verification error:", err);
      }
    };
    const interval = setInterval(verifyStreamState, 100_000);
    return () => clearInterval(interval);
  }, [stream.isStreaming]);

  const setStream = (state: StreamState | ((prev: StreamState) => StreamState)) => {
    setStreamState(typeof state === "function" ? state : state);
  };

  const activeSlots = stream.isStreaming ? Math.min(4, Math.max(1, stream.modelCount + 1)) : 0;

  return (
    <StreamContext.Provider value={{ stream, setStream, activeSlots }}>
      {children}
    </StreamContext.Provider>
  );
}
