import { useState, useEffect, useRef } from "react";
import { useToast } from "@/hooks/use-toast";
import { useStream } from "@/hooks/useStreamContext";
import { useRecording } from "@/hooks/useRecording";
import { RecordingState } from "@/contexts/RecordingContext";
import { HlsPlayer } from "@/components/live/HlsPlayer";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { validateRecordingDuration } from "@/lib/validation";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface StreamSlot {
  slot: number;
  name: string;
  available: boolean;
}

const RecordingPage = () => {
  const { toast } = useToast();
  const { stream } = useStream();
  const { recording, setRecording, recordingTime } = useRecording();

  // Prevent duplicate requests
  const isStoppingRef = useRef(false);
  const isPausingRef = useRef(false);

  // UI state for loading indicators
  const [isStopping, setIsStopping] = useState(false);

  // Poll available slots from /api/stream
  const [availableSlots, setAvailableSlots] = useState<StreamSlot[]>([]);

  useEffect(() => {
    if (!stream.isStreaming) {
      setAvailableSlots([]);
      return;
    }

    const load = async () => {
      try {
        const res = await fetch("/api/stream");
        if (!res.ok) return;
        const data = await res.json();
        const slots: StreamSlot[] = (data.streams || []).map((s: any) => ({
          slot: s.slot,
          name: s.slot === 1 ? "Raw Stream" : s.name || `Model ${s.slot - 1}`,
          available: true,
        }));
        setAvailableSlots(slots);
      } catch { /* noop */ }
    };

    load();
    const interval = setInterval(load, 3000);
    return () => clearInterval(interval);
  }, [stream.isStreaming]);

  const handleSavePath = () => {
    if (!recording.savePath.trim()) {
      toast({ variant: "destructive", title: "No path entered", description: "Please enter a folder path first." });
      return;
    }
    const trimmed = recording.savePath.trim();
    // Context's setRecording will handle localStorage persistence and custom event
    setRecording((prev: RecordingState) => ({ ...prev, savePath: trimmed }));
    toast({ title: "Save folder set", description: trimmed });
  };

  const slotDisplayLabel = (slot: StreamSlot): string => {
    if (slot.slot === 1) return "Raw Stream";
    return `${slot.name} — Slot ${slot.slot - 1}`;
  };

  const getSlotHlsUrl = (slot: number): string => {
    return `/api/stream/slot/${slot}/index.m3u8`;
  };

  const handleStartRecording = async () => {
    if (!stream.isStreaming) {
      toast({ variant: "destructive", title: "No active stream", description: "Start a stream first." });
      return;
    }
    if (!recording.selectedSlot) {
      toast({ variant: "destructive", title: "Select a slot", description: "Choose which stream to record." });
      return;
    }
    if (!recording.savePath) {
      toast({ variant: "destructive", title: "No save folder", description: "Enter and save a folder path first." });
      return;
    }

    const internalSlot = parseInt(recording.selectedSlot, 10);
    const slotInfo = availableSlots.find((s: StreamSlot) => s.slot === internalSlot);
    const modelName = slotInfo && slotInfo.slot !== 1 ? slotInfo.name : undefined;

    try {
      const res = await fetch("/api/recordings/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          slot: internalSlot,
          model_name: modelName,
          save_path: recording.savePath,
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.detail || "Failed to start recording");
      }
      const data = await res.json();
      setRecording((prev: RecordingState) => ({
        ...prev,
        sessionId: data.session_id,
        isRecording: true,
        isPaused: false,
        recordingStartTime: Date.now(),
      }));
      toast({ title: "Recording Started", description: slotInfo ? slotDisplayLabel(slotInfo) : `Slot ${recording.selectedSlot}` });
    } catch (err) {
      toast({ variant: "destructive", title: "Error", description: err instanceof Error ? err.message : "Failed to start recording" });
    }
  };

  const handlePauseRecording = async () => {
    if (!recording.sessionId || isPausingRef.current) return;
    isPausingRef.current = true;
    try {
      const res = await fetch("/api/recordings/pause", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: recording.sessionId }),
      });
      if (!res.ok) throw new Error("Failed to pause");
      setRecording((prev: RecordingState) => ({
        ...prev,
        isPaused: true,
        recordingPausedAt: Date.now(),
      }));
      toast({ title: "Recording Paused" });
    } catch (err) {
      toast({ variant: "destructive", title: "Error", description: err instanceof Error ? err.message : "Failed to pause" });
    } finally {
      isPausingRef.current = false;
    }
  };

  const handleResumeRecording = async () => {
    if (!recording.sessionId) return;
    try {
      const res = await fetch("/api/recordings/resume", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: recording.sessionId }),
      });
      if (!res.ok) throw new Error("Failed to resume");
      // Calculate pause duration and adjust recordingStartTime forward
      setRecording((prev: RecordingState) => {
        let newStartTime = prev.recordingStartTime;
        if (prev.recordingPausedAt && prev.recordingStartTime) {
          // Shift the start time forward by the pause duration
          const pauseDuration = Date.now() - prev.recordingPausedAt;
          newStartTime = prev.recordingStartTime + pauseDuration;
        }
        return {
          ...prev,
          isPaused: false,
          recordingStartTime: newStartTime,
          recordingPausedAt: null, // Clear pause tracking
        };
      });
      toast({ title: "Recording Resumed" });
    } catch (err) {
      toast({ variant: "destructive", title: "Error", description: err instanceof Error ? err.message : "Failed to resume" });
    }
  };

  const handleStopRecording = async () => {
    if (!recording.sessionId || isStoppingRef.current) {
      if (!recording.sessionId) {
        toast({ variant: "destructive", title: "Error", description: "No active recording session" });
      }
      return;
    }

    // Validate recording duration — must be at least 1 second
    const validation = validateRecordingDuration(recordingTime, 1);
    if (!validation.valid) {
      toast({ variant: "destructive", title: "Recording Too Short", description: validation.error });
      return;
    }

    isStoppingRef.current = true;
    setIsStopping(true);

    try {
      const res = await fetch("/api/recordings/stop", {
        method: "POST",
        headers: { "Content-Type": "application/json"},
        body: JSON.stringify({ session_id: recording.sessionId }),
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
        sessionId: null,
        isRecording: false,
        isPaused: false,
        recordingStartTime: null,
        recordingPausedAt: null,
      }));
      toast({ title: "Recording Saved", description: `${data.filename} — ${mins}m ${secs}s` });
    } catch (err) {
      toast({ variant: "destructive", title: "Error", description: err instanceof Error ? err.message : "Failed to stop recording" });
    } finally {
      isStoppingRef.current = false;
      setIsStopping(false);
    }
  };

  const formatTime = (seconds: number): string => {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    if (h > 0) return `${h}h ${m}m ${s}s`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
  };

  const selectedSlotInfo = availableSlots.find((s: StreamSlot) => s.slot === parseInt(recording.selectedSlot || "0"));

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
              placeholder="e.g. /home/pi/recordings"
              value={recording.savePath}
              onChange={(e: any) => setRecording((prev: RecordingState) => ({ ...prev, savePath: e.currentTarget.value }))}
              className="flex-1"
            />
            <Button onClick={handleSavePath}>
              Save
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Enter an absolute path on your Raspberry Pi. The folder will be created if it doesn't exist.
          </p>
        </div>

        <div className="space-y-2">
          <Label>Record From</Label>
          {!stream.isStreaming ? (
            <div className="rounded-md border border-dashed border-border bg-muted/50 p-3 text-sm text-muted-foreground">
              No active stream — start a stream first
            </div>
          ) : availableSlots.length === 0 ? (
            <div className="rounded-md border border-dashed border-border bg-muted/50 p-3 text-sm text-muted-foreground">
              Loading streams...
            </div>
          ) : (
            <Select
              value={recording.selectedSlot ?? undefined}
              onValueChange={(val: string) => setRecording((prev: RecordingState) => ({ ...prev, selectedSlot: val }))}
            >
              <SelectTrigger>
                <SelectValue placeholder="Select Slot" />
              </SelectTrigger>
              <SelectContent>
                {availableSlots.map((s: StreamSlot) => (
                  <SelectItem key={s.slot} value={String(s.slot)}>
                    {slotDisplayLabel(s)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>

        <Button
          onClick={handleStartRecording}
          disabled={recording.isRecording || !stream.isStreaming || !recording.selectedSlot || !recording.savePath || availableSlots.length === 0}
          className="w-full"
        >
          Start Recording
        </Button>
      </div>

      {/* Active recording */}
      {recording.isRecording && (
        <div className="rounded-lg border border-border bg-card p-6 space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-lg font-semibold">Recording in Progress</h3>
              <p className="text-sm text-muted-foreground">
                {selectedSlotInfo ? slotDisplayLabel(selectedSlotInfo) : `Slot ${recording.selectedSlot}`}
              </p>
            </div>
            <div className="flex items-center gap-2">
              {!recording.isPaused && (
                <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-red-500" />
              )}
              <div className="text-3xl font-mono font-bold">{formatTime(recordingTime)}</div>
            </div>
          </div>

          {/* Video preview and controls side by side */}
          <div className="flex gap-4">
            {/* Live preview of recording slot */}
            {recording.selectedSlot && recording.isRecording && (
              <div className="w-2/3">
                <div className="rounded-lg border border-border bg-black/10 overflow-hidden">
                  <div className="aspect-video w-full bg-black flex items-center justify-center">
                    <HlsPlayer src={getSlotHlsUrl(parseInt(recording.selectedSlot, 10))} showPlaceholder={false} />
                  </div>
                </div>
              </div>
            )}

            {/* Control buttons */}
            <div className="w-1/3 flex flex-col gap-2">
              {recording.isPaused ? (
                <Button onClick={handleResumeRecording} disabled={isPausingRef.current} className="w-full">
                  Resume
                </Button>
              ) : (
                <Button onClick={handlePauseRecording} variant="outline" disabled={isPausingRef.current} className="w-full">
                  Pause
                </Button>
              )}
              <Button 
                onClick={handleStopRecording} 
                variant="destructive" 
                disabled={isStopping || isStoppingRef.current}
                className="w-full"
              >
                {isStopping ? "Saving..." : "Stop & Save"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default RecordingPage;