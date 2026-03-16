import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import App from "./App";
import TranscriptView from "./pages/TranscriptView";
import NotesList from "./pages/NotesList";
import "./index.css";
import DashboardWrapper from "./components/modules/DashboardWrapper";
import { Toaster } from "./components/ui/Sonner";

const queryClient = new QueryClient();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Toaster />
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route path="/dashboard/*" element={<DashboardRoutes />} />
          <Route
            path="*"
            element={<Navigate replace to="/dashboard/" />}
          />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>,
);

function DashboardRoutes() {
  return (
    <DashboardWrapper>
      <Routes>
        <Route path="/" element={<App />} />
        <Route path="notes/:botId" element={<TranscriptPage />} />
        <Route path="knowledge-base" element={<KnowledgeBase />} />
        <Route path="transcripts" element={<TranscriptsPage />} />
        <Route path="voice-agent" element={<VoiceAgentPage />} />
        <Route path="settings" element={<SettingsPage />} />
      </Routes>
    </DashboardWrapper>
  );
}
