export interface RecordedVideo {
  id: string;
  name: string;
  url: string;
  size: number;
  createdAt: Date;
}

export function getSavedRecordings(): RecordedVideo[] {
  const saved = localStorage.getItem("recordedVideos");
  if (!saved) return [];
  
  try {
    const parsed = JSON.parse(saved) as Array<{
      id: string;
      name: string;
      url: string;
      size: number;
      createdAt: string;
    }>;
    
    return parsed.map((video) => ({
      ...video,
      createdAt: new Date(video.createdAt),
    }));
  } catch {
    return [];
  }
}

export function saveRecording(file: File): void {
  const recordings = getSavedRecordings();
  const id = `rec_${Date.now()}`;
  const url = URL.createObjectURL(file);

  const newRecording: RecordedVideo = {
    id,
    name: file.name,
    url,
    size: file.size,
    createdAt: new Date(),
  };

  recordings.unshift(newRecording);
  localStorage.setItem("recordedVideos", JSON.stringify(recordings));
}

export function deleteRecording(id: string): void {
  const recordings = getSavedRecordings();
  const index = recordings.findIndex((r) => r.id === id);
  
  if (index !== -1) {
    const recording = recordings[index];
    // Revoke the object URL if it exists
    if (recording.url.startsWith("blob:")) {
      URL.revokeObjectURL(recording.url);
    }
    recordings.splice(index, 1);
    localStorage.setItem("recordedVideos", JSON.stringify(recordings));
  }
}

export function formatFileSize(bytes: number): string {
  if (bytes === 0) return "0 Bytes";
  const k = 1024;
  const sizes = ["Bytes", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + " " + sizes[i];
}
