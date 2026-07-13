import { useEffect, useRef, useState } from "react";

interface MjpegPlayerProps {
  src: string | null;
  showPlaceholder?: boolean;
}

// MJPEG (multipart/x-mixed-replace) "just works" in a plain <img> tag — no
// hls.js, no segmenting, no buffering, so latency is roughly one frame plus
// network. Unlike <video>+hls.js, <img> has no built-in reconnect on a
// dropped connection, so we retry by remounting with a cache-busting query
// param on error.
export function MjpegPlayer({ src, showPlaceholder = true }: MjpegPlayerProps) {
  const [retryNonce, setRetryNonce] = useState(0);
  const retryTimer = useRef<number | null>(null);

  useEffect(() => {
    setRetryNonce(0); // fresh src (e.g. new stream session) — drop any pending retry
    return () => {
      if (retryTimer.current) window.clearTimeout(retryTimer.current);
    };
  }, [src]);

  const handleError = () => {
    if (retryTimer.current) window.clearTimeout(retryTimer.current);
    retryTimer.current = window.setTimeout(() => setRetryNonce((n) => n + 1), 2000);
  };

  if (!src) {
    return showPlaceholder ? (
      <div className="grid aspect-video w-full max-w-4xl place-items-center rounded-lg border border-dashed border-border bg-card">
        <span className="text-sm text-muted-foreground">Select a source above to begin streaming</span>
      </div>
    ) : (
      <div className="aspect-video w-full overflow-hidden rounded-lg border border-border bg-black" />
    );
  }

  const resolvedSrc = retryNonce === 0 ? src : `${src}${src.includes("?") ? "&" : "?"}_retry=${retryNonce}`;

  return (
    <div className="relative h-full w-full overflow-hidden rounded-lg border border-border bg-black">
      <img
        key={resolvedSrc}
        src={resolvedSrc}
        onError={handleError}
        className="h-full w-full object-contain"
        alt=""
      />
    </div>
  );
}
