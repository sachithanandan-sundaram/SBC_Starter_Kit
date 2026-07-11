import { Trash2, FileVideo, Calendar, HardDrive } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import type { RecordedVideo } from "@/lib/recordingsManager";
import { formatFileSize } from "@/lib/recordingsManager";
import { Button } from "@/components/ui/button";

interface RecordingsListProps {
  recordings: RecordedVideo[];
  selectedId: string | null;
  onSelect: (recording: RecordedVideo) => void;
  onDelete: (id: string) => void;
}

export function RecordingsList({
  recordings,
  selectedId,
  onSelect,
  onDelete,
}: RecordingsListProps) {
  return (
    <div className="flex flex-col gap-3">
      {/* Header */}
      <div>
        <h2 className="text-sm font-semibold text-foreground">
          Recorded Videos
        </h2>
        <p className="text-xs text-muted-foreground">
          {recordings.length} recording{recordings.length !== 1 ? "s" : ""}
        </p>
      </div>

      {/* Recordings list */}
      <div className="flex flex-col gap-1.5">
        {recordings.length === 0 && (
          <div className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
            No recordings yet. Create one from the Recording page.
          </div>
        )}
        {recordings.map((recording) => (
          <button
            key={recording.id}
            onClick={() => onSelect(recording)}
            className={`group flex items-center gap-3 rounded-lg border p-3 text-left transition-all duration-150 ${
              selectedId === recording.id
                ? "border-primary bg-primary/5"
                : "border-border bg-card hover:bg-muted/50"
            }`}
          >
            {/* Video icon */}
            <div className="h-12 w-12 shrink-0 flex items-center justify-center rounded-md border border-border bg-muted">
              <FileVideo className="h-6 w-6 text-muted-foreground" />
            </div>

            {/* Recording info */}
            <div className="flex flex-1 flex-col gap-1 overflow-hidden">
              <span className="truncate text-sm font-medium text-foreground">
                {recording.name}
              </span>
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <HardDrive className="h-3 w-3" />
                <span>{formatFileSize(recording.size)}</span>
              </div>
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Calendar className="h-3 w-3" />
                <span>
                  {recording.createdAt.toLocaleString()} (
                  {formatDistanceToNow(recording.createdAt, { addSuffix: true })})
                </span>
              </div>
            </div>

            {/* Delete button */}
            <div className="opacity-0 transition-opacity group-hover:opacity-100">
              <Button
                variant="ghost"
                size="sm"
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete(recording.id);
                }}
                className="text-destructive hover:text-destructive hover:bg-destructive/10"
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
