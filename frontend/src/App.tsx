import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Route, Routes, Navigate } from "react-router-dom";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { StreamProvider } from "@/contexts/StreamContext";
import { RecordingProvider } from "@/contexts/RecordingContext";
import DashboardLayout from "./layout/DashboardLayout";
import LiveViewPage from "./pages/LiveViewPage";
import RecordingPage from "./pages/RecordingPage";
import PlaybackPage from "./pages/PlaybackPage";
import ModelsPage from "./pages/ModelsPage";
import NotFound from "./pages/NotFound";

const queryClient = new QueryClient();

const App = () => (
  <QueryClientProvider client={queryClient}>
    <StreamProvider>
      <RecordingProvider>
        <TooltipProvider>
          <Toaster />
          <Sonner />
          <BrowserRouter>
            <Routes>
              <Route element={<DashboardLayout />}>
                <Route path="/" element={<Navigate to="/live" replace />} />
                <Route path="/live" element={<LiveViewPage />} />
                <Route path="/recording" element={<RecordingPage />} />
                <Route path="/playback" element={<PlaybackPage />} />
                <Route path="/models" element={<ModelsPage />} />
              </Route>
              <Route path="*" element={<NotFound />} />
            </Routes>
          </BrowserRouter>
        </TooltipProvider>
      </RecordingProvider>
    </StreamProvider>
  </QueryClientProvider>
);

export default App;
