import { useState, useEffect } from "react";
import { useToast } from "@/hooks/use-toast";
import { useStream } from "@/hooks/useStreamContext";
import { RtspInput } from "@/components/live/RtspInput";
import { UsbSelector } from "@/components/live/UsbSelector";
import { VideoFileInput } from "@/components/live/VideoFileInput";
import { GridCell } from "@/components/live/GridCell";
import { AlertCircle, X } from "lucide-react";
import { validateRtspUrl } from "@/lib/validation";

type SourceType = "RTSP" | "USB" | "Video File";
const SOURCES: SourceType[] = ["RTSP", "USB", "Video File"];
const MAX_CAMERAS = 4;

const LiveViewPage = () => {
  const { toast } = useToast();
  const { stream, setStream, activeSlots } = useStream();
  const [activeSource, setActiveSource] = useState<SourceType>("RTSP");
  // RTSP tab: one or more camera URLs. A single URL uses the legacy
  // single-camera / multi-model path; 2+ URLs trigger the new multi-camera,
  // single-model path (one voyager-sdk session, N tiles, same model on all).
  const [rtspUrls, setRtspUrls] = useState<string[]>([]);
  const [selectedUsb, setSelectedUsb] = useState<string | null>(null);
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);
  const [slotTitles, setSlotTitles] = useState<Record<number, string>>({ 1: "Raw Stream" });
  const [inferenceReady, setInferenceReady] = useState<Record<number, boolean>>({});

  useEffect(() => {
    if (!stream.sourceType || !stream.sourceValue) return;
    if (stream.sourceType === "RTSP") { setRtspUrls([stream.sourceValue]); setActiveSource("RTSP"); }
    else if (stream.sourceType === "USB") { setSelectedUsb(stream.sourceValue); setActiveSource("USB"); }
    else if (stream.sourceType === "Video File") { setSelectedFilePath(stream.sourceValue); setActiveSource("Video File"); }
  }, [stream.sourceType, stream.sourceValue]);

  const handleSourceChange = (source: SourceType) => {
    setActiveSource(source);
    if (stream.isStreaming) handleStopStream();
  };

  const handleAddRtspUrl = (url: string) => {
    const trimmed = url.trim();
    if (!trimmed) return;
    const validation = validateRtspUrl(trimmed);
    if (!validation.valid) {
      toast({ variant: "destructive", title: "Validation Error", description: validation.error || "Please enter a valid RTSP URL" });
      return;
    }
    setRtspUrls((prev) => {
      if (prev.includes(trimmed)) return prev;
      if (prev.length >= MAX_CAMERAS) {
        toast({ variant: "destructive", title: "Limit reached", description: `Maximum ${MAX_CAMERAS} cameras` });
        return prev;
      }
      return [...prev, trimmed];
    });
  };

  const handleRemoveRtspUrl = (url: string) => {
    setRtspUrls((prev) => prev.filter((u) => u !== url));
  };

  const slotHlsUrl = (slot: number): string => {
    const fragment = stream.sessionToken ? `#${stream.sessionToken}` : "";
    return `/api/stream/slot/${slot}/index.m3u8${fragment}`;
  };

  // Inference tiles use MJPEG (near-real-time, ~1 frame latency) instead of
  // HLS (~16s: encode -> segment -> player buffer). HLS is still produced
  // under the hood for recording — this only changes what's displayed live.
  const slotMjpegUrl = (slot: number): string => {
    const fragment = stream.sessionToken ? `#${stream.sessionToken}` : "";
    return `/api/stream/slot/${slot}/mjpeg${fragment}`;
  };

  // Per-camera raw (pre-overlay) tile — same slot numbering as the paired
  // inference tile, same sub-second latency, no MediaMTX/HLS involved.
  const slotRawMjpegUrl = (slot: number): string => {
    const fragment = stream.sessionToken ? `#${stream.sessionToken}` : "";
    return `/api/stream/slot/${slot}/raw.mjpeg${fragment}`;
  };

  const handleStartStream = async () => {
    let sourceType: SourceType | null = null;
    let sourceValue: string | null = null;
    let body: Record<string, unknown>;

    if (activeSource === "RTSP") {
      if (rtspUrls.length === 0) { toast({ variant: "destructive", title: "Validation Error", description: "Add at least one RTSP URL" }); return; }
      sourceType = "RTSP";
      if (rtspUrls.length > 1) {
        body = { source_type: "RTSP", sources: rtspUrls };
      } else {
        sourceValue = rtspUrls[0];
        body = { source_type: "RTSP", source_value: sourceValue };
      }
    } else if (activeSource === "USB") {
      if (!selectedUsb) { toast({ variant: "destructive", title: "Validation Error", description: "Please select a USB camera" }); return; }
      sourceType = "USB"; sourceValue = selectedUsb;
      body = { source_type: sourceType, source_value: sourceValue };
    } else {
      if (!selectedFilePath) { toast({ variant: "destructive", title: "Validation Error", description: "Please select a video file" }); return; }
      sourceType = "Video File"; sourceValue = selectedFilePath;
      body = { source_type: sourceType, source_value: sourceValue };
    }

    if (!sourceType) return;
    const multiCameraCount = sourceType === "RTSP" && rtspUrls.length > 1 ? rtspUrls.length : 0;

    try {
      const res = await fetch("/api/stream/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.detail || "Failed to start stream");
      }
      setStream({
        sourceType,
        sourceValue,
        isStreaming: true,
        modelCount: stream.modelCount,
        showAnnotated: stream.modelCount > 0,
        multiCameraCount,
        sessionToken: (crypto.randomUUID ? crypto.randomUUID() : "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => { const r = Math.random()*16|0; return (c==="x"?r:(r&0x3|0x8)).toString(16); })),
      });
      setInferenceReady({});
      toast({
        title: "Stream Started",
        description: multiCameraCount > 0
          ? `${multiCameraCount} cameras running the same model`
          : `Connected to ${sourceType}`,
      });
    } catch (err) {
      toast({ variant: "destructive", title: "Stream Error", description: err instanceof Error ? err.message : "Failed to start stream" });
    }
  };

  const handleStopStream = async () => {
    try {
      const res = await fetch("/api/stream/stop", { method: "DELETE" });
      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.detail || "Failed to stop stream");
      }
      setStream({ sourceType: null, sourceValue: null, isStreaming: false, modelCount: stream.modelCount, showAnnotated: false, multiCameraCount: 0, sessionToken: "" });
      setInferenceReady({});
      setRtspUrls([]);
      toast({ title: "Stream Stopped" });
    } catch (err) {
      toast({ variant: "destructive", title: "Error", description: err instanceof Error ? err.message : "Failed to stop stream" });
    }
  };

  useEffect(() => {
    if (!stream.isStreaming) {
      setSlotTitles({ 1: "Raw Stream" });
      setInferenceReady({});
      return;
    }

    const load = async () => {
      // Update slot titles
      try {
        const res = await fetch("/api/stream");
        if (res.ok) {
          const data = await res.json();
          const next: Record<number, string> = { 1: "Raw Stream" };
          for (const s of data.streams || []) {
            if (typeof s.slot === "number" && typeof s.name === "string") next[s.slot] = s.name;
          }
          setSlotTitles(next);
        }
      } catch { /* noop */ }

      // Just check playlist returns 200 and contains at least one .ts line —
      // no HEAD probe (FastAPI FileResponse only allows GET, HEAD returns 405 via nginx)
      const tileCount = stream.multiCameraCount > 0 ? stream.multiCameraCount : stream.modelCount;
      if (tileCount > 0) {
        for (let s = 2; s <= Math.min(tileCount, 4) + 1; s++) {
          try {
            const r = await fetch(`/api/stream/slot/${s}/index.m3u8`);
            if (!r.ok) {
              setInferenceReady(prev => prev[s] ? { ...prev, [s]: false } : prev);
              continue;
            }
            const text = await r.text();
            const hasSegments = text.split("\n").some(
              l => l.trim().endsWith(".ts") && !l.startsWith("#")
            );
            setInferenceReady(prev =>
              prev[s] === hasSegments ? prev : { ...prev, [s]: hasSegments }
            );
          } catch {
            setInferenceReady(prev => prev[s] ? { ...prev, [s]: false } : prev);
          }
        }
      }
    };

    load();
    const interval = setInterval(load, 3000);
    return () => clearInterval(interval);
  }, [stream.isStreaming, stream.modelCount, stream.multiCameraCount]);

  const isMultiCamera = stream.multiCameraCount > 0;
  const inferenceSlots = isMultiCamera
    ? Array.from({ length: Math.min(4, stream.multiCameraCount) }, (_, i) => i + 2)
    : stream.modelCount > 0
      ? Array.from({ length: Math.min(4, stream.modelCount) }, (_, i) => i + 2)
      : [];

  const tileTitle = (slot: number): string => {
    if (isMultiCamera) return `Camera ${slot - 1} — Inference`;
    return slotTitles[slot] || `Model ${slot - 1}`;
  };

  const rawTileTitle = (slot: number): string => `Camera ${slot - 1} — Raw`;

  // Shared tile renderer for both the raw and inference grids in multi-camera
  // mode — same readiness gating (both hubs for a camera come online
  // together, part of the same session), same placeholder while waiting.
  const renderTile = (
    key: string,
    slot: number,
    src: string,
    title: string,
    waitingLabel: string
  ) => (
    <div key={key} className="overflow-hidden rounded-lg border border-border" style={{ height: "35vh", minHeight: "220px" }}>
      {inferenceReady[slot] ? (
        <GridCell cellNumber={slot as 2 | 3 | 4} src={src} mode="mjpeg" title={title} />
      ) : (
        <div className="flex h-full flex-col items-center justify-center gap-3 bg-muted/30 text-muted-foreground">
          <div className="h-7 w-7 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          <div className="text-center">
            <p className="text-sm font-medium">{title}</p>
            <p className="text-xs mt-0.5">{waitingLabel}</p>
          </div>
        </div>
      )}
    </div>
  );

  return (
    <div className="flex flex-col space-y-6">
      {!stream.isStreaming ? (
        <div className="space-y-4">
          <div className="flex w-fit items-center gap-1 rounded-lg bg-muted p-1">
            {SOURCES.map((source) => (
              <button
                key={source}
                onClick={() => handleSourceChange(source)}
                className={`rounded-md px-3 py-1.5 text-sm font-medium transition-all duration-200 ${
                  activeSource === source
                    ? "bg-primary text-primary-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {source}
              </button>
            ))}
          </div>

          <div className="w-full max-w-4xl rounded-lg border border-border bg-card p-4">
            {activeSource === "RTSP" && (
              <div className="space-y-4">
                <RtspInput onConnect={handleAddRtspUrl} />
                <div className="space-y-1.5">
                  <p className="text-xs font-medium text-muted-foreground">
                    Cameras ({rtspUrls.length}/{MAX_CAMERAS}) — add 2+ to run one model across a 2×2 grid
                  </p>
                  {rtspUrls.length > 0 && (
                    <div className="flex flex-col gap-0.5 rounded-md border border-border bg-muted/30 p-1">
                      {rtspUrls.map((url) => (
                        <div key={url} className="group flex items-center justify-between rounded px-2 py-1.5 hover:bg-muted">
                          <span className="flex-1 truncate font-mono text-xs text-foreground">{url}</span>
                          <button
                            onClick={() => handleRemoveRtspUrl(url)}
                            className="ml-2 shrink-0 text-muted-foreground hover:text-destructive"
                          >
                            <X className="h-3 w-3" />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}
            {activeSource === "USB" && <UsbSelector onSelect={(deviceId) => setSelectedUsb(deviceId)} />}
            {activeSource === "Video File" && <VideoFileInput onSelect={(filePath) => setSelectedFilePath(filePath)} />}
          </div>

          <button
            onClick={handleStartStream}
            disabled={
              (activeSource === "RTSP" && rtspUrls.length === 0) ||
              (activeSource === "USB" && !selectedUsb) ||
              (activeSource === "Video File" && !selectedFilePath)
            }
            className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Start Stream
          </button>
        </div>
      ) : (
        <>
          {(stream.modelCount > 0 || isMultiCamera) && (
            <div className="flex items-start gap-3 rounded-lg border border-blue-200/50 bg-blue-50/50 p-3">
              <AlertCircle className="h-5 w-5 shrink-0 text-blue-600 mt-0.5" />
              <p className="text-sm font-medium text-blue-900">
                {isMultiCamera
                  ? `${stream.multiCameraCount} camera${stream.multiCameraCount !== 1 ? "s" : ""} running the same model — raw + inference tile per camera`
                  : `${stream.modelCount} model${stream.modelCount !== 1 ? "s" : ""} running inference • tile 1 is raw stream`}
              </p>
            </div>
          )}

          <div className="flex items-center justify-between">
            <div className="text-sm text-muted-foreground">
              {isMultiCamera
                ? `${stream.sourceType} • ${stream.multiCameraCount} camera${stream.multiCameraCount !== 1 ? "s" : ""} • ${inferenceSlots.length * 2} tiles active`
                : `${stream.sourceType} • ${activeSlots} slot${activeSlots !== 1 ? "s" : ""} active`}
            </div>
            <button
              onClick={handleStopStream}
              className="rounded-lg bg-destructive px-3 py-1.5 text-sm font-medium text-destructive-foreground hover:bg-destructive/90"
            >
              Stop Stream
            </button>
          </div>

          <div className="w-full space-y-4">
            {isMultiCamera ? (
              <>
                <div className="space-y-2">
                  <div className="inline-flex items-center rounded-md bg-muted px-3 py-1 text-xs font-semibold text-muted-foreground">
                    Raw Feeds
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    {inferenceSlots.map((slot) =>
                      renderTile(`raw-${slot}`, slot, slotRawMjpegUrl(slot), rawTileTitle(slot), "Waiting for camera stream...")
                    )}
                  </div>
                </div>

                {inferenceSlots.length > 0 && (
                  <div className="space-y-2">
                    <div className="inline-flex items-center rounded-md bg-muted px-3 py-1 text-xs font-semibold text-muted-foreground">
                      Inference Feeds
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      {inferenceSlots.map((slot) =>
                        renderTile(`inf-${slot}`, slot, slotMjpegUrl(slot), tileTitle(slot), "Waiting for inference stream...")
                      )}
                    </div>
                  </div>
                )}
              </>
            ) : (
              <>
                <div className="space-y-2">
                  <div className="inline-flex items-center rounded-md bg-muted px-3 py-1 text-xs font-semibold text-muted-foreground">
                    Raw Stream
                  </div>
                  <div className="flex justify-start">
                    <div className="h-[40vh] min-h-[260px] w-full max-w-4xl overflow-hidden rounded-lg border border-border">
                      <GridCell cellNumber={1} src={slotHlsUrl(1)} title="Raw Stream" />
                    </div>
                  </div>
                </div>

                {inferenceSlots.length > 0 && (
                  <div className="space-y-2">
                    <div className="inline-flex items-center rounded-md bg-muted px-3 py-1 text-xs font-semibold text-muted-foreground">
                      Model Inference Streams
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      {inferenceSlots.map((slot) =>
                        renderTile(`inf-${slot}`, slot, slotMjpegUrl(slot), tileTitle(slot), "Waiting for inference stream...")
                      )}
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
};

export default LiveViewPage;
