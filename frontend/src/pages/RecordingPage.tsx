import { useState, useEffect } from "react";
import { useToast } from "@/hooks/use-toast";
import { useStream } from "@/hooks/useStreamContext";
import { useRecording } from "@/hooks/useRecording";
import { RecordingState } from "@/contexts/RecordingContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { validateRecordingDuration } from "@/lib/validation";

interface RawCameraOption {
  index: number;
  label: string;
}

interface InferenceSlotOption {
  slot: number;
  label: string;
}

const RecordingPage = () => {
  const { toast } = useToast();
  const { stream } = useStream();
  const { recording, setRecording, elapsedSeconds } = useRecording();

  // Per-row in-flight indicators, keyed by a request key (not session_id,
  // since "start" hasn't produced one yet) or session_id for pause/stop.
  const [busyKeys, setBusyKeys] = useState<Set<string>>(new Set());
  const setBusy = (key: string, busy: boolean) => {
    setBusyKeys((prev) => {
      const next = new Set(prev);
      if (busy) next.add(key); else next.delete(key);
      return next;
    });
  };

  // Raw camera feeds (from the multi-camera session, or the single legacy
  // raw stream) and inference slots (from /api/stream) available to record.
  const [rawCameras, setRawCameras] = useState<RawCameraOption[]>([]);
  const [inferenceSlots, setInferenceSlots] = useState<InferenceSlotOption[]>([]);

  useEffect(() => {
    if (!stream.isStreaming) {
      setRawCameras([]);
      setInferenceSlots([]);
      return;
    }

    const load = async () => {
      try {
        const [statusRes, streamRes] = await Promise.all([
          fetch("/api/stream/status"),
          fetch("/api/stream"),
        ]);

        if (statusRes.ok) {
          const status = await statusRes.json();
          const session = status.session;
          if (session?.active && Array.isArray(session.sources) && session.sources.length > 0) {
            setRawCameras(session.sources.map((_: string, i: number) => ({ index: i, label: `Camera ${i}` })));
          } else if (status.slots?.["1"]?.running) {
            setRawCameras([{ index: 0, label: "Raw Stream" }]);
          } else {
            setRawCameras([]);
          }
        }

        if (streamRes.ok) {
          const data = await streamRes.json();
          const slots: InferenceSlotOption[] = (data.streams || [])
            .filter((s: any) => typeof s.slot === "number" && s.slot !== 1)
            .map((s: any) => ({
              slot: s.slot,
              label: stream.multiCameraCount > 0 ? `Camera ${s.slot - 1}` : (s.name || `Model ${s.slot - 1}`),
            }));
          setInferenceSlots(slots);
        }
      } catch { /* noop */ }
    };

    load();
    const interval = setInterval(load, 3000);
    return () => clearInterval(interval);
  }, [stream.isStreaming, stream.multiCameraCount]);

  const handleSavePath = () => {
    if (!recording.savePath.trim()) {
      toast({ variant: "destructive", title: "No path entered", description: "Please enter a folder path first." });
      return;
    }
    const trimmed = recording.savePath.trim();
    setRecording((prev: RecordingState) => ({ ...prev, savePath: trimmed }));
    toast({ title: "Save folder set", description: trimmed });
  };

  const startRecording = async (
    kind: "raw" | "inference",
    cameraIndex: number,
    slot: number | null,
    label: string,
    requestKey: string
  ) => {
    if (!recording.savePath) {
      toast({ variant: "destructive", title: "No save folder", description: "Enter and save a folder path first." });
      return;
    }
    setBusy(requestKey, true);
    try {
      const res = await fetch("/api/recordings/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind,
          camera_index: cameraIndex,
          slot: slot ?? undefined,
          save_path: recording.savePath,
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.detail || "Failed to start recording");
      }
      const data = await res.json();
      const now = Date.now();
      setRecording((prev: RecordingState) => ({
        ...prev,
        sessions: [
          ...prev.sessions,
          {
            sessionId: data.session_id,
            kind,
            cameraIndex,
            slot,
            label,
            filename: data.filename,
            startTime: now,
            pausedAt: null,
          },
        ],
      }));
      toast({ title: "Recording Started", description: label });
    } catch (err) {
      toast({ variant: "destructive", title: "Error", description: err instanceof Error ? err.message : "Failed to start recording" });
    } finally {
      setBusy(requestKey, false);
    }
  };

  const pauseRecording = async (sessionId: string) => {
    setBusy(sessionId, true);
    try {
      const res = await fetch("/api/recordings/pause", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: sessionId }),
      });
      if (!res.ok) throw new Error("Failed to pause");
      setRecording((prev: RecordingState) => ({
        ...prev,
        sessions: prev.sessions.map((s) =>
          s.sessionId === sessionId ? { ...s, pausedAt: Date.now() } : s
        ),
      }));
    } catch (err) {
      toast({ variant: "destructive", title: "Error", description: err instanceof Error ? err.message : "Failed to pause" });
    } finally {
      setBusy(sessionId, false);
    }
  };

  const resumeRecording = async (sessionId: string) => {
    setBusy(sessionId, true);
    try {
      const res = await fetch("/api/recordings/resume", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: sessionId }),
      });
      if (!res.ok) throw new Error("Failed to resume");
      setRecording((prev: RecordingState) => ({
        ...prev,
        sessions: prev.sessions.map((s) => {
          if (s.sessionId !== sessionId) return s;
          const pauseDuration = s.pausedAt ? Date.now() - s.pausedAt : 0;
          return { ...s, startTime: s.startTime + pauseDuration, pausedAt: null };
        }),
      }));
    } catch (err) {
      toast({ variant: "destructive", title: "Error", description: err instanceof Error ? err.message : "Failed to resume" });
    } finally {
      setBusy(sessionId, false);
    }
  };

  const stopRecording = async (sessionId: string) => {
    const session = recording.sessions.find((s) => s.sessionId === sessionId);
    if (!session) return;

    const validation = validateRecordingDuration(elapsedSeconds(session), 1);
    if (!validation.valid) {
      toast({ variant: "destructive", title: "Recording Too Short", description: validation.error });
      return;
    }

    setBusy(sessionId, true);
    try {
      const res = await fetch("/api/recordings/stop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: sessionId }),
      });
      if (!res.ok) {
        const errText = await res.text();
        throw new Error(errText);
      }
      const data = await res.json();
      const mins = Math.floor(data.duration_seconds / 60);
      const secs = Math.floor(data.duration_seconds % 60);
      setRecording((prev: RecordingState) => ({
        ...prev,
        sessions: prev.sessions.filter((s) => s.sessionId !== sessionId),
      }));
      toast({ title: "Recording Saved", description: `${data.filename} — ${mins}m ${secs}s` });
    } catch (err) {
      toast({ variant: "destructive", title: "Error", description: err instanceof Error ? err.message : "Failed to stop recording" });
    } finally {
      setBusy(sessionId, false);
    }
  };

  const formatTime = (seconds: number): string => {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) return `${h}h ${m}m ${s}s`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
  };

  const isRawRecording = (index: number) =>
    recording.sessions.some((s) => s.kind === "raw" && s.cameraIndex === index);
  const isInferenceRecording = (slot: number) =>
    recording.sessions.some((s) => s.kind === "inference" && s.slot === slot);

  return (
    <div className="flex flex-col space-y-6">
      {/* Setup */}
      <div className="rounded-lg border border-border bg-card p-6 space-y-4">
        <h2 className="text-lg font-semibold">Recording Setup</h2>

        <div className="space-y-2">
          <Label>Save Folder</Label>
          <div className="flex gap-2">
            <Input
              type="text"
              placeholder="e.g. /home/user/recordings"
              value={recording.savePath}
              onChange={(e: any) => setRecording((prev: RecordingState) => ({ ...prev, savePath: e.currentTarget.value }))}
              className="flex-1"
            />
            <Button onClick={handleSavePath}>
              Save
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Enter an absolute path on this Metis Compute Board (host filesystem). The folder will be created if it doesn't exist.
          </p>
        </div>

        {!stream.isStreaming ? (
          <div className="rounded-md border border-dashed border-border bg-muted/50 p-3 text-sm text-muted-foreground">
            No active stream — start a stream first
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label>Raw Feeds</Label>
              {rawCameras.length === 0 ? (
                <div className="rounded-md border border-dashed border-border bg-muted/50 p-3 text-sm text-muted-foreground">
                  No raw feed available
                </div>
              ) : (
                <div className="flex flex-col gap-2">
                  {rawCameras.map((cam) => {
                    const key = `raw-${cam.index}`;
                    const recording_ = isRawRecording(cam.index);
                    return (
                      <div key={key} className="flex items-center justify-between rounded-md border border-border p-2">
                        <span className="text-sm">{cam.label}</span>
                        <Button
                          size="sm"
                          variant={recording_ ? "secondary" : "default"}
                          disabled={recording_ || busyKeys.has(key) || !recording.savePath}
                          onClick={() => startRecording("raw", cam.index, null, `${cam.label} — Raw`, key)}
                        >
                          {recording_ ? "Recording…" : "Record"}
                        </Button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="space-y-2">
              <Label>Inference Feeds</Label>
              {inferenceSlots.length === 0 ? (
                <div className="rounded-md border border-dashed border-border bg-muted/50 p-3 text-sm text-muted-foreground">
                  No inference stream available yet
                </div>
              ) : (
                <div className="flex flex-col gap-2">
                  {inferenceSlots.map((s) => {
                    const key = `inf-${s.slot}`;
                    const recording_ = isInferenceRecording(s.slot);
                    return (
                      <div key={key} className="flex items-center justify-between rounded-md border border-border p-2">
                        <span className="text-sm">{s.label}</span>
                        <Button
                          size="sm"
                          variant={recording_ ? "secondary" : "default"}
                          disabled={recording_ || busyKeys.has(key) || !recording.savePath}
                          onClick={() => startRecording("inference", s.slot - 1, s.slot, `${s.label} — Inference`, key)}
                        >
                          {recording_ ? "Recording…" : "Record"}
                        </Button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Active recordings */}
      {recording.sessions.length > 0 && (
        <div className="rounded-lg border border-border bg-card p-6 space-y-3">
          <h3 className="text-lg font-semibold">Active Recordings</h3>
          <div className="flex flex-col gap-2">
            {recording.sessions.map((s) => {
              const busy = busyKeys.has(s.sessionId);
              const paused = s.pausedAt !== null;
              return (
                <div key={s.sessionId} className="flex items-center justify-between rounded-md border border-border p-3">
                  <div className="flex items-center gap-3">
                    {!paused && <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-red-500" />}
                    <div>
                      <p className="text-sm font-medium">{s.label}</p>
                      <p className="text-xs text-muted-foreground font-mono">{s.filename}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="text-lg font-mono font-semibold">{formatTime(elapsedSeconds(s))}</div>
                    {paused ? (
                      <Button size="sm" variant="outline" disabled={busy} onClick={() => resumeRecording(s.sessionId)}>
                        Resume
                      </Button>
                    ) : (
                      <Button size="sm" variant="outline" disabled={busy} onClick={() => pauseRecording(s.sessionId)}>
                        Pause
                      </Button>
                    )}
                    <Button size="sm" variant="destructive" disabled={busy} onClick={() => stopRecording(s.sessionId)}>
                      Stop & Save
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};

export default RecordingPage;
