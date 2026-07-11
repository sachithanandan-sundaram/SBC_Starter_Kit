import { useState, useEffect, useRef, useCallback } from "react";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Play, RefreshCw, FolderOpen } from "lucide-react";

interface VideoFile {
  filename: string;
  modified: string;
  size_mb: number;
  duration_s: number;
}

const FILES_CACHE_KEY = "playbackFilesCache";
const POLL_INTERVAL_MS = 10_000; // 10 s — backend ffprobe is now cached, but no need to hammer it

// Read the persisted file list from localStorage (populated on every successful fetch).
// This means navigating back to this page shows the list immediately, with no spinner.
function readCachedFiles(): VideoFile[] {
  try {
    const raw = localStorage.getItem(FILES_CACHE_KEY);
    return raw ? (JSON.parse(raw) as VideoFile[]) : [];
  } catch {
    return [];
  }
}

const PlaybackPage = () => {
  const { toast } = useToast();

  // ── Save path ─────────────────────────────────────────────────────────────
  // Read once on mount from localStorage; never reset on re-mount so the
  // page always opens on the last-used folder.
  const [savePath, setSavePath] = useState<string>(() => {
    return localStorage.getItem("recordingSavePath") ?? "";
  });

  // Keep path in sync if RecordingPage changes it in the same tab or another tab
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === "recordingSavePath") setSavePath(e.newValue ?? "");
    };
    const onCustom = (e: Event) => {
      setSavePath((e as CustomEvent<string>).detail ?? "");
    };
    window.addEventListener("storage", onStorage);
    window.addEventListener("recordingPathChanged", onCustom);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("recordingPathChanged", onCustom);
    };
  }, []);

  // ── File list ─────────────────────────────────────────────────────────────
  // Seed from cache so the list appears instantly on navigate-back.
  const [files, setFiles] = useState<VideoFile[]>(readCachedFiles);

  // `loading` is only true when there is no cache yet — avoids spinner flash
  // on every background poll.
  const [loading, setLoading] = useState(() => readCachedFiles().length === 0);

  const [selectedFile, setSelectedFile] = useState<VideoFile | null>(null);
  const [selectedFileName, setSelectedFileName] = useState<string | null>(null);

  // Stable ref so the interval callback always sees the latest savePath
  // without needing to be re-created on every path change.
  const savePathRef = useRef(savePath);
  useEffect(() => { savePathRef.current = savePath; }, [savePath]);

  // ── Fetch helper ──────────────────────────────────────────────────────────
  const fetchFiles = useCallback(async (showSpinner = false) => {
    const path = savePathRef.current;
    if (!path) return;

    if (showSpinner) setLoading(true);

    try {
      const url = new URL("/api/playback/list", window.location.origin);
      url.searchParams.set("save_path", path);

      const res = await fetch(url.toString());
      if (!res.ok) throw new Error("Failed to load recordings");
      const data = await res.json();
      const fetched: VideoFile[] = data.files ?? [];

      setFiles(fetched);

      // Persist so next page visit is instant
      try {
        localStorage.setItem(FILES_CACHE_KEY, JSON.stringify(fetched));
      } catch { /* storage quota — ignore */ }
    } catch (err) {
      toast({
        variant: "destructive",
        title: "Error",
        description: err instanceof Error ? err.message : "Failed to load recordings",
      });
    } finally {
      if (showSpinner) setLoading(false);
    }
  }, [toast]);

  // ── Poll — restart when savePath changes ──────────────────────────────────
  useEffect(() => {
    if (!savePath) {
      setFiles([]);
      setSelectedFile(null);
      setSelectedFileName(null);
      return;
    }

    // First call: show spinner only if cache is empty
    const hasCache = readCachedFiles().length > 0;
    fetchFiles(!hasCache);

    const id = setInterval(() => fetchFiles(false), POLL_INTERVAL_MS);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savePath]); // fetchFiles is stable, savePath is the real dependency

  // ── Keep selected file in sync with the refreshed list ───────────────────
  useEffect(() => {
    if (files.length === 0) {
      setSelectedFile(null);
      setSelectedFileName(null);
      return;
    }
    if (selectedFileName) {
      const found = files.find((f) => f.filename === selectedFileName);
      setSelectedFile(found ?? files[0]);
      if (!found) setSelectedFileName(files[0].filename);
    } else if (!selectedFile) {
      setSelectedFile(files[0]);
      setSelectedFileName(files[0].filename);
    }
  }, [files]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Manual refresh button ─────────────────────────────────────────────────
  const handleRefresh = async () => {
    if (!savePath) return;
    await fetchFiles(true);
    toast({ title: "Refreshed", description: "Recording list updated" });
  };

  // ── Formatters ────────────────────────────────────────────────────────────
  const formatDuration = (seconds: number): string => {
    if (!seconds || seconds <= 0) return "0s";
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) return `${h}h ${m}m ${s}s`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
  };

  const formatDate = (isoString: string): string => {
    try {
      return new Date(isoString).toLocaleString();
    } catch {
      return isoString;
    }
  };

  return (
    <div className="flex flex-col space-y-4">
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[360px_1fr]">
        {/* Left Panel — Recordings List */}
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold">Recordings</h2>
            <Button
              onClick={handleRefresh}
              variant="ghost"
              size="sm"
              disabled={loading || !savePath}
              className="h-8 w-8 p-0"
            >
              <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
            </Button>
          </div>

          {!savePath ? (
            <div className="flex items-center justify-center rounded-lg border border-dashed border-border bg-muted/30 py-8 text-center">
              <div className="flex flex-col items-center gap-2">
                <FolderOpen className="h-6 w-6 text-muted-foreground" />
                <p className="text-sm text-muted-foreground">No folder selected</p>
                <p className="text-xs text-muted-foreground">
                  Set a save folder in the Recording tab
                </p>
              </div>
            </div>
          ) : loading ? (
            <div className="flex items-center justify-center rounded-lg border border-dashed border-border bg-muted/30 py-8">
              <div className="flex flex-col items-center gap-2 text-muted-foreground">
                <RefreshCw className="h-5 w-5 animate-spin" />
                <p className="text-sm">Loading recordings…</p>
              </div>
            </div>
          ) : files.length === 0 ? (
            <div className="flex items-center justify-center rounded-lg border border-dashed border-border bg-muted/30 py-8 text-center">
              <p className="text-sm text-muted-foreground">No recordings found</p>
            </div>
          ) : (
            <div className="flex flex-col gap-2 overflow-y-auto">
              {files.map((file) => (
                <button
                  key={file.filename}
                  onClick={() => {
                    setSelectedFile(file);
                    setSelectedFileName(file.filename);
                  }}
                  className={`rounded-lg border p-3 text-left transition-all ${
                    selectedFile?.filename === file.filename
                      ? "border-primary bg-primary/10"
                      : "border-border hover:bg-muted"
                  }`}
                >
                  <div className="truncate font-mono text-sm font-medium">
                    {file.filename}
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    {formatDuration(file.duration_s)} • {formatDate(file.modified)}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Right Panel — Video Player */}
        <div className="flex flex-col gap-3">
          {selectedFile ? (
            <>
              <div className="text-sm font-semibold">{selectedFile.filename}</div>
              <div className="aspect-video w-full overflow-hidden rounded-lg border border-border bg-black">
                <video
                  key={selectedFile.filename}
                  src={`/api/playback/video/${encodeURIComponent(selectedFile.filename)}?save_path=${encodeURIComponent(savePath)}`}
                  controls
                  className="h-full w-full"
                />
              </div>
              <div className="text-xs text-muted-foreground">
                {formatDuration(selectedFile.duration_s)} • {formatDate(selectedFile.modified)}
              </div>
            </>
          ) : (
            <div className="flex items-center justify-center rounded-lg border border-dashed border-border bg-card/50 py-16 text-center">
              <div className="flex flex-col items-center gap-2">
                <Play className="h-8 w-8 text-muted-foreground" />
                <p className="text-sm text-muted-foreground">
                  {!savePath
                    ? "Set a save folder to view recordings"
                    : "Select a recording to play it here"}
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default PlaybackPage;