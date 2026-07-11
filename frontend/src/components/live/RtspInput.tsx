import { useState } from "react";
import { X, Clock } from "lucide-react";
import { useRtspHistory } from "@/hooks/useRtspHistory";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface RtspInputProps {
  onConnect: (url: string) => void;
}

export function RtspInput({ onConnect }: RtspInputProps) {
  const [url, setUrl] = useState("");
  const { history, addUrl, removeUrl } = useRtspHistory();

  const handleConnect = (): void => {
    const trimmed = url.trim();
    if (!trimmed) return;
    addUrl(trimmed);
    onConnect(trimmed);
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex gap-2">
        <Input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleConnect()}
          placeholder="rtsp://username:password@192.168.1.x:554/stream"
          className="font-mono text-sm"
        />
        <Button onClick={handleConnect} disabled={!url.trim()}>
          Connect
        </Button>
      </div>

      {history.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <Clock className="h-3 w-3" />
            Saved streams
          </p>
          <div className="flex flex-col gap-0.5 rounded-md border border-border bg-muted/30 p-1">
            {history.map((savedUrl) => (
              <div
                key={savedUrl}
                className="group flex items-center justify-between rounded px-2 py-1.5 hover:bg-muted"
              >
                <button
                  className="flex-1 truncate text-left font-mono text-xs text-foreground"
                  onClick={() => setUrl(savedUrl)}
                >
                  {savedUrl}
                </button>
                <button
                  onClick={() => removeUrl(savedUrl)}
                  className="ml-2 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:text-destructive"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}