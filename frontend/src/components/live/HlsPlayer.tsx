import { useEffect, useRef } from "react";
import Hls from "hls.js";
import type { ErrorData } from "hls.js";

interface HlsPlayerProps {
  src: string | null;
  showPlaceholder?: boolean;
}

export function HlsPlayer({ src, showPlaceholder = true }: HlsPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !src) return;

    if (src.startsWith("blob:")) {
      video.src = src;
      return;
    }

    if (!Hls.isSupported()) {
      if (video.canPlayType("application/vnd.apple.mpegurl")) {
        video.src = src;
        video.play().catch(() => null);
      }
      return;
    }

    console.log("[HlsPlayer] Initializing hls.js for:", src);

    const hls = new Hls({
      enableWorker: true,
      debug: false,

      maxBufferLength: 10,
      maxMaxBufferLength: 20,
      maxBufferSize: 20 * 1000 * 1000,
      liveSyncDurationCount: 2,
      liveMaxLatencyDurationCount: 4,

      // More aggressive retries for segment 404s (race condition)
      manifestLoadingMaxRetry: 10,
      manifestLoadingRetryDelay: 500,
      manifestLoadingMaxRetryTimeout: 2000,

      levelLoadingMaxRetry: 10,
      levelLoadingRetryDelay: 500,
      levelLoadingMaxRetryTimeout: 2000,

      // Key fix: retry segments aggressively with short delay
      fragLoadingMaxRetry: 10,
      fragLoadingRetryDelay: 300,
      fragLoadingMaxRetryTimeout: 2000,
    });

    hls.loadSource(src);
    hls.attachMedia(video);
    hlsRef.current = hls;

    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      console.log("[HlsPlayer] MANIFEST_PARSED — levels:", hls.levels.length);
      video.play().catch((err) => console.warn("[HlsPlayer] play() failed:", err));
    });

    let stalledCount = 0;
    let lastTime = -1;

    const recoverPlayback = () => {
      const instance = hlsRef.current;
      if (!instance) return;
      try {
        instance.startLoad(-1);
        instance.recoverMediaError();
        video.play().catch(() => null);
      } catch { /* noop */ }
    };

    video.addEventListener("stalled", () => {
      stalledCount++;
      if (stalledCount >= 2) { recoverPlayback(); stalledCount = 0; }
    });
    video.addEventListener("waiting", () => {
      stalledCount++;
      if (stalledCount >= 2) { recoverPlayback(); stalledCount = 0; }
    });
    video.addEventListener("playing", () => { stalledCount = 0; });

    const progressWatchdog = window.setInterval(() => {
      if (document.hidden || video.paused) {
        if (video.paused) video.play().catch(() => null);
        return;
      }
      if (lastTime >= 0 && Math.abs(video.currentTime - lastTime) < 0.01) {
        stalledCount++;
        if (stalledCount >= 3) { recoverPlayback(); stalledCount = 0; }
      } else {
        stalledCount = 0;
      }
      lastTime = video.currentTime;
    }, 3000);

    hls.on(Hls.Events.ERROR, (_event: unknown, data: ErrorData) => {
      console.warn("[HlsPlayer] ERROR:", data.type, data.details, "fatal:", data.fatal);

      // Non-fatal frag 404 — segment not written yet, force manifest reload
      // so hls.js re-fetches the playlist and picks up new sequence numbers
      if (
        !data.fatal &&
        data.type === Hls.ErrorTypes.NETWORK_ERROR &&
        (data.details === Hls.ErrorDetails.FRAG_LOAD_ERROR ||
          data.details === Hls.ErrorDetails.FRAG_LOAD_TIMEOUT)
      ) {
        console.warn("[HlsPlayer] segment load error — reloading manifest");
        hls.startLoad(-1);
        return;
      }

      if (!data.fatal) return;

      if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
        console.warn("[HlsPlayer] fatal network error, recovering...");
        hls.startLoad();
      } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
        console.warn("[HlsPlayer] fatal media error, recovering...");
        hls.recoverMediaError();
      } else {
        console.error("[HlsPlayer] UNRECOVERABLE — destroying");
        hls.destroy();
      }
    });

    document.addEventListener("visibilitychange", () => {
      const instance = hlsRef.current;
      if (!instance || document.hidden) return;
      try { instance.startLoad(-1); video.play().catch(() => null); } catch { /* noop */ }
    });

    return () => {
      window.clearInterval(progressWatchdog);
      hlsRef.current = null;
      hls.destroy();
    };
  }, [src]);

  if (!src) {
    return showPlaceholder ? (
      <div className="grid aspect-video w-full max-w-4xl place-items-center rounded-lg border border-dashed border-border bg-card">
        <span className="text-sm text-muted-foreground">Select a source above to begin streaming</span>
      </div>
    ) : (
      <div className="aspect-video w-full overflow-hidden rounded-lg border border-border bg-black" />
    );
  }

  return (
    <div className="relative h-full w-full overflow-hidden rounded-lg border border-border bg-black">
      <video
        ref={videoRef}
        className="h-full w-full object-contain"
        muted
        autoPlay
        playsInline
        controls={false}
      />
    </div>
  );
}