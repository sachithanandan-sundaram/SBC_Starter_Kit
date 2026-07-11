import { useEffect } from "react";
import { RefreshCw, Camera } from "lucide-react";
import { useUsbDevices } from "@/hooks/useUsbDevices";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface UsbSelectorProps {
  onSelect: (deviceId: string, label: string) => void;
}

export function UsbSelector({ onSelect }: UsbSelectorProps) {
  const { devices, error, loading, enumerate } = useUsbDevices();

  useEffect(() => {
    void enumerate();
  }, []);

  if (error) {
    return (
      <div className="flex flex-col gap-2">
        <p className="text-sm text-destructive">{error}</p>
        {/* <Button variant="outline" size="sm" onClick={() => void enumerate()}>
          Try again
        </Button> */}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <Select
        onValueChange={(value) => {
          const device = devices.find((d) => d.deviceId === value);
          if (device) onSelect(device.deviceId, device.label);
        }}
        disabled={loading || devices.length === 0}
      >
        <SelectTrigger className="w-72">
          <div className="flex items-center gap-2">
            <Camera className="h-4 w-4 shrink-0 text-muted-foreground" />
            <SelectValue
              placeholder={loading ? "Detecting cameras…" : "Select a camera"}
            />
          </div>
        </SelectTrigger>
        <SelectContent>
          {devices.map((device) => (
            <SelectItem key={device.deviceId} value={device.deviceId}>
              {device.label}
            </SelectItem>
          ))}
          {devices.length === 0 && !loading && (
            <div className="px-3 py-2 text-sm text-muted-foreground">
              No cameras found
            </div>
          )}
        </SelectContent>
      </Select>
      <Button
        variant="ghost"
        size="icon"
        onClick={() => void enumerate()}
        disabled={loading}
        title="Refresh devices"
      >
        <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
      </Button>
    </div>
  );
}