import { useEffect, useRef, useState } from "react";
import { AlertCircle } from "lucide-react";

interface MJPEGPlayerProps {
  src: string | null;
  showPlaceholder?: boolean;
}

export function MJPEGPlayer({ src, showPlaceholder = true }: MJPEGPlayerProps) {
  const imgRef = useRef<HTMLImageElement>(null);
  const [error, setError] = useState(false);
  const [retryCount, setRetryCount] = useState(0);

  useEffect(() => {
    const img = imgRef.current;
    if (!img || !src) {
      setError(false);
      return;
    }

    setError(false);
    img.src = src;
    
    const handleLoad = () => {
      setError(false);
      setRetryCount(0);
    };

    const handleError = () => {
      setError(true);
      // Retry loading after a short delay
      setRetryCount((prev) => prev + 1);
      if (retryCount < 5) {
        setTimeout(() => {
          img.src = src + `?t=${Date.now()}`;
        }, 2000);
      }
    };

    img.onload = handleLoad;
    img.onerror = handleError;

    return () => {
      img.src = "";
      img.onload = null;
      img.onerror = null;
    };
  }, [src, retryCount]);

  if (!src) {
    if (!showPlaceholder) {
      return (
        <div className="h-full w-full overflow-hidden bg-black" />
      );
    }

    return (
      <div className="grid h-full w-full place-items-center overflow-hidden rounded-lg border border-dashed border-border bg-card">
        <div className="flex flex-col items-center gap-2 text-center">
          <span className="text-sm text-muted-foreground">
            Select a source above to begin streaming
          </span>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-3 bg-black">
        <AlertCircle className="h-8 w-8 text-red-500" />
        <div className="text-center text-sm text-red-400">
          <p>Stream Unavailable</p>
          <p className="text-xs text-muted-foreground">Retrying connection...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="relative h-full w-full overflow-hidden bg-black">
      <img
        ref={imgRef}
        alt="MJPEG Stream"
        className="h-full w-full object-cover"
      />
    </div>
  );
}
