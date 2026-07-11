import { useContext } from "react";
import { RecordingContext } from "@/contexts/RecordingContext";

export function useRecording() {
  const context = useContext(RecordingContext);
  if (!context) {
    throw new Error("useRecording must be used within RecordingProvider");
  }
  return context;
}
