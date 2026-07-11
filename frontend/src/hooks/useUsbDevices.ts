import { useState, useCallback, useRef } from "react";

export interface VideoDevice {
  deviceId: string;
  label: string;
}

const CACHE_DURATION = 5000; // Cache results for 5 seconds

export function useUsbDevices() {
  const [devices, setDevices] = useState<VideoDevice[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const cacheRef = useRef<{ devices: VideoDevice[]; timestamp: number } | null>(null);

  const enumerate = useCallback(async (): Promise<void> => {
    // Use cached results if available and fresh
    if (cacheRef.current && Date.now() - cacheRef.current.timestamp < CACHE_DURATION) {
      setDevices(cacheRef.current.devices);
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/cameras");
      if (!res.ok) {
        throw new Error(`Camera enumeration failed: ${res.statusText}`);
      }
      const data = await res.json();
      
      // Convert backend camera indices to devices
      const videoInputs: VideoDevice[] = data.cameras.map(
        (cam: { index: number; name: string }) => ({
          deviceId: String(cam.index),
          label: cam.name || `Camera ${cam.index}`,
        })
      );
      
      // Cache the results
      cacheRef.current = { devices: videoInputs, timestamp: Date.now() };
      
      setDevices(videoInputs);
      
      if (videoInputs.length === 0) {
        setError("No cameras detected");
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to enumerate cameras";
      setError(message);
      setDevices([]);
    } finally {
      setLoading(false);
    }
  }, []);

  return { devices, error, loading, enumerate };
}