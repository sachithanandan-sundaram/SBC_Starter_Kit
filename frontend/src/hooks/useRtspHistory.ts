import { useState, useEffect } from "react";

const STORAGE_KEY = "rtsp_url_history";
const MAX_HISTORY = 10;

export function useRtspHistory() {
  const [history, setHistory] = useState<string[]>(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      return stored ? (JSON.parse(stored) as string[]) : [];
    } catch {
      return [];
    }
  });

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(history));
  }, [history]);

  const addUrl = (url: string): void => {
    const trimmed = url.trim();
    if (!trimmed) return;
    setHistory((prev) => {
      const filtered = prev.filter((u) => u !== trimmed);
      return [trimmed, ...filtered].slice(0, MAX_HISTORY);
    });
  };

  const removeUrl = (url: string): void => {
    setHistory((prev) => prev.filter((u) => u !== url));
  };

  return { history, addUrl, removeUrl };
}