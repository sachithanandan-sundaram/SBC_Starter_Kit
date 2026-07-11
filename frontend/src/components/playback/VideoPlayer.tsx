import { useEffect, useRef } from "react";
import Hls from "hls.js";
import { FileVideo, HardDrive, Calendar } from "lucide-react";
import type { RecordedVideo } from "@/lib/recordingsManager";
import { formatFileSize } from "@/lib/recordingsManager";

interface VideoPlayerProps {
  recording: RecordedVideo | null;
}

export function VideoPlayer({ recording }: VideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !recording) return;

    // For blob URLs or local files, we can play them directly
    if (recording.url.startsWith("blob:")) {
      video.src = recording.url;
      return;
    }

    // Try HLS for other URLs
    if (Hls.isSupported()) {
      const hls = new Hls();
      hls.loadSource(recording.url);
      hls.attachMedia(video);
      
      const handleManifestParsed = () => {
        const currentVideo = videoRef.current;
        if (currentVideo) {
          currentVideo.play().catch(() => null);
        }
      };
      
      hls.on(Hls.Events.MANIFEST_PARSED, handleManifestParsed);
      return () => {
        hls.off(Hls.Events.MANIFEST_PARSED, handleManifestParsed);
        hls.destroy();
      };
    }

    // Fallback for native support
    if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = recording.url;
    }
  }, [recording?.url]);

  if (!recording) {
    return (
      <div className="grid aspect-video w-full place-items-center rounded-lg border border-dashed border-border bg-card">
        <div className="flex flex-col items-center gap-2 text-center">
          <FileVideo className="h-8 w-8 text-muted-foreground/30" />
          <span className="text-sm text-muted-foreground">
            Select a recording to view playback
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {/* Recording metadata */}
      <div className="rounded-lg border border-border bg-card p-3">
        <div className="flex items-start justify-between gap-4">
          <div className="flex flex-col gap-1">
            <span className="text-sm font-semibold text-foreground">
              {recording.name}
            </span>
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <HardDrive className="h-3.5 w-3.5" />
              <span>{formatFileSize(recording.size)}</span>
            </div>
          </div>
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Calendar className="h-3.5 w-3.5" />
            <span>{recording.createdAt.toLocaleString()}</span>
          </div>
        </div>
      </div>

      {/* Video player with full controls */}
      <div className="overflow-hidden rounded-lg border border-border bg-black">
        <video
          ref={videoRef}
          className="aspect-video w-full"
          controls
          playsInline
        />
      </div>
    </div>
  );
}
