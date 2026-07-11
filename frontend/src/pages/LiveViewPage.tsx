import { useState, useEffect } from "react";
import { useToast } from "@/hooks/use-toast";
import { useStream } from "@/hooks/useStreamContext";
import { RtspInput } from "@/components/live/RtspInput";
import { UsbSelector } from "@/components/live/UsbSelector";
import { VideoFileInput } from "@/components/live/VideoFileInput";
import { GridCell } from "@/components/live/GridCell";
import { AlertCircle } from "lucide-react";
import { validateRtspUrl } from "@/lib/validation";

type SourceType = "RTSP" | "USB" | "Video File";
const SOURCES: SourceType[] = ["RTSP", "USB", "Video File"];

const LiveViewPage = () => {
  const { toast } = useToast();
  const { stream, setStream, activeSlots } = useStream();
  const [activeSource, setActiveSource] = useState<SourceType>("RTSP");
  const [rtspUrl, setRtspUrl] = useState("");
  const [isRtspUrlValid, setIsRtspUrlValid] = useState(false);
  const [selectedUsb, setSelectedUsb] = useState<string | null>(null);
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);
  const [slotTitles, setSlotTitles] = useState<Record<number, string>>({ 1: "Raw Stream" });
  const [inferenceReady, setInferenceReady] = useState<Record<number, boolean>>({});

  useEffect(() => {
    if (!stream.sourceType || !stream.sourceValue) return;
    if (stream.sourceType === "RTSP") { setRtspUrl(stream.sourceValue); setActiveSource("RTSP"); }
    else if (stream.sourceType === "USB") { setSelectedUsb(stream.sourceValue); setActiveSource("USB"); }
    else if (stream.sourceType === "Video File") { setSelectedFilePath(stream.sourceValue); setActiveSource("Video File"); }
  }, [stream.sourceType, stream.sourceValue]);

  // Validate RTSP URL as user types
  useEffect(() => {
    if (activeSource === "RTSP") {
      const validation = validateRtspUrl(rtspUrl);
      setIsRtspUrlValid(validation.valid);
    }
  }, [rtspUrl, activeSource]);

  const handleSourceChange = (source: SourceType) => {
    setActiveSource(source);
    if (stream.isStreaming) handleStopStream();
  };

  const slotHlsUrl = (slot: number): string => {
    const fragment = stream.sessionToken ? `#${stream.sessionToken}` : "";
    return `/api/stream/slot/${slot}/index.m3u8${fragment}`;
  };

  const handleStartStream = async () => {
    let sourceType: SourceType | null = null;
    let sourceValue: string | null = null;

    if (activeSource === "RTSP") {
      if (!rtspUrl || !isRtspUrlValid) { toast({ variant: "destructive", title: "Validation Error", description: "Please enter a valid RTSP URL" }); return; }
      sourceType = "RTSP"; sourceValue = rtspUrl;
    } else if (activeSource === "USB") {
      if (!selectedUsb) { toast({ variant: "destructive", title: "Validation Error", description: "Please select a USB camera" }); return; }
      sourceType = "USB"; sourceValue = selectedUsb;
    } else if (activeSource === "Video File") {
      if (!selectedFilePath) { toast({ variant: "destructive", title: "Validation Error", description: "Please select a video file" }); return; }
      sourceType = "Video File"; sourceValue = selectedFilePath;
    }

    if (!sourceType || !sourceValue) return;

    try {
      const res = await fetch("/api/stream/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source_type: sourceType, source_value: sourceValue }),
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
        sessionToken: (crypto.randomUUID ? crypto.randomUUID() : "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => { const r = Math.random()*16|0; return (c==="x"?r:(r&0x3|0x8)).toString(16); })),
      });
      setInferenceReady({});
      toast({ title: "Stream Started", description: `Connected to ${sourceType}` });
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
      setStream({ sourceType: null, sourceValue: null, isStreaming: false, modelCount: stream.modelCount, showAnnotated: false, sessionToken: "" });
      setInferenceReady({});
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
      if (stream.modelCount > 0) {
        for (let s = 2; s <= Math.min(stream.modelCount, 4) + 1; s++) {
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
  }, [stream.isStreaming, stream.modelCount]);

  const inferenceSlots = stream.modelCount > 0
    ? Array.from({ length: Math.min(4, stream.modelCount) }, (_, i) => i + 2)
    : [];

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
            {activeSource === "RTSP" && <RtspInput onConnect={(url) => setRtspUrl(url)} />}
            {activeSource === "USB" && <UsbSelector onSelect={(deviceId) => setSelectedUsb(deviceId)} />}
            {activeSource === "Video File" && <VideoFileInput onSelect={(filePath) => setSelectedFilePath(filePath)} />}
          </div>

          <button
            onClick={handleStartStream}
            disabled={
              (activeSource === "RTSP" && !isRtspUrlValid) ||
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
          {stream.modelCount > 0 && (
            <div className="flex items-start gap-3 rounded-lg border border-blue-200/50 bg-blue-50/50 p-3">
              <AlertCircle className="h-5 w-5 shrink-0 text-blue-600 mt-0.5" />
              <p className="text-sm font-medium text-blue-900">
                {stream.modelCount} model{stream.modelCount !== 1 ? "s" : ""} running inference • tile 1 is raw stream
              </p>
            </div>
          )}

          <div className="flex items-center justify-between">
            <div className="text-sm text-muted-foreground">
              {stream.sourceType} • {activeSlots} slot{activeSlots !== 1 ? "s" : ""} active
            </div>
            <button
              onClick={handleStopStream}
              className="rounded-lg bg-destructive px-3 py-1.5 text-sm font-medium text-destructive-foreground hover:bg-destructive/90"
            >
              Stop Stream
            </button>
          </div>

          <div className="w-full space-y-4">
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
                  {inferenceSlots.map((slot) => (
                    <div
                      key={slot}
                      className="overflow-hidden rounded-lg border border-border"
                      style={{ height: "35vh", minHeight: "220px" }}
                    >
                      {inferenceReady[slot] ? (
                        <GridCell
                          cellNumber={slot as 2 | 3 | 4}
                          src={slotHlsUrl(slot)}
                          title={slotTitles[slot] || `Model ${slot - 1}`}
                        />
                      ) : (
                        <div className="flex h-full flex-col items-center justify-center gap-3 bg-muted/30 text-muted-foreground">
                          <div className="h-7 w-7 animate-spin rounded-full border-2 border-primary border-t-transparent" />
                          <div className="text-center">
                            <p className="text-sm font-medium">{slotTitles[slot] || `Model ${slot - 1}`}</p>
                            <p className="text-xs mt-0.5">Waiting for inference stream...</p>
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
};

export default LiveViewPage;
