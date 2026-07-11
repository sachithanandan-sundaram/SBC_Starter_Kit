import { useContext } from "react";
import { StreamContext } from "@/contexts/StreamContext";

export function useStream() {
  const context = useContext(StreamContext);
  if (!context) {
    throw new Error("useStream must be used within StreamProvider");
  }
  return context;
}
