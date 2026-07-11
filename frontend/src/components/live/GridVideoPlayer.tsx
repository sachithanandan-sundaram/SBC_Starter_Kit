import { useState } from "react";
import { Maximize2, X } from "lucide-react";
import { HlsPlayer } from "./HlsPlayer";

interface GridVideoPlayerProps {
  src: string | null;
  title?: string;
}

export function GridVideoPlayer({ src, title }: GridVideoPlayerProps) {
  const [isEnlarged, setIsEnlarged] = useState(false);

  const player = () => (
    <HlsPlayer src={src} showPlaceholder={false} />
  );

  return (
    <>
      <div className="relative h-full w-full overflow-hidden rounded-none bg-black">
        {player()}

        {src && (
          <div className="absolute right-3 top-3 flex gap-2">
            <button
              onClick={() => setIsEnlarged(true)}
              className="rounded-lg bg-black/50 p-2 text-white transition-all hover:bg-black/80"
              title="Fullscreen"
            >
              <Maximize2 className="h-5 w-5" />
            </button>
          </div>
        )}
      </div>

      {isEnlarged && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/95 p-4 backdrop-blur-sm">
          <div className="relative h-full w-full max-w-6xl">
            <HlsPlayer src={src} showPlaceholder={false} />
            <button
              onClick={() => setIsEnlarged(false)}
              className="absolute right-4 top-4 rounded-lg bg-black/50 p-2 text-white transition-all hover:bg-black/80"
            >
              <X className="h-6 w-6" />
            </button>
            {title && (
              <div className="absolute bottom-4 left-4 rounded-md bg-black/45 px-2 py-1 text-sm text-white/80 backdrop-blur-sm">
                {title}
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}