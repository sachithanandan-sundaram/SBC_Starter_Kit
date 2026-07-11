import { useState } from "react";
import { X, Info, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";

interface VideoFileInputProps {
  onSelect: (filePath: string) => void;
}

export function VideoFileInput({ onSelect }: VideoFileInputProps) {
  const { toast } = useToast();
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const file = e.target.files?.[0] ?? null;
    setSelectedFile(file);
  };

  const handleSelect = async (): Promise<void> => {
    if (!selectedFile || uploading) {
      return;
    }

    setUploading(true);
    try {
      const formData = new FormData();
      formData.append("file", selectedFile);

      const res = await fetch("/api/stream/upload-video", {
        method: "POST",
        body: formData,
      });

      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.detail || "Failed to upload video");
      }

      const data = await res.json();
      onSelect(data.source_path);
      toast({ title: "Video Selected", description: selectedFile.name });
    } catch (err) {
      toast({
        variant: "destructive",
        title: "Upload Failed",
        description: err instanceof Error ? err.message : "Failed to upload video",
      });
    } finally {
      setUploading(false);
    }
  };

  const handleClear = (): void => {
    setSelectedFile(null);
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-md border border-blue-200/50 bg-blue-50/30 p-2.5 text-xs text-blue-700">
        <div className="flex gap-2">
          <Info className="h-4 w-4 shrink-0 mt-0.5" />
          <span>Browse and upload a local video file from your computer.</span>
        </div>
      </div>
      
      <div className="flex flex-col gap-2">
        <Input
          type="file"
          accept="video/*"
          onChange={handleChange}
        />
        {selectedFile && (
          <div className="text-xs text-muted-foreground">
            {selectedFile.name}
          </div>
        )}
        <div className="flex gap-2">
          <Button
            onClick={handleSelect}
            disabled={!selectedFile || uploading}
            className="gap-2"
          >
            <Upload className="h-4 w-4" />
            {uploading ? "Uploading..." : "Use Video File"}
          </Button>
          {selectedFile && (
            <Button
              variant="outline"
              onClick={handleClear}
              disabled={uploading}
              className="gap-2"
            >
              <X className="h-4 w-4" />
              Clear
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
