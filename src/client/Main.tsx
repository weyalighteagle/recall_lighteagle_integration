import { ClerkProvider, useAuth } from "@clerk/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import App from "./App";
import TranscriptView from "./pages/TranscriptView";
import NotesList from "./pages/NotesList";
import KnowledgeBase from "./pages/KnowledgeBase";
import VoiceAgentPage from "./pages/VoiceAgentPage";
import SettingsPage from "./pages/SettingsPage";
import InstantMeetingPage from "./pages/InstantMeetingPage";
import VoiceAgentSettingsPage from "./pages/VoiceAgentSettingsPage";
import SignInPage from "./pages/SignInPage";
import "./index.css";
import DashboardWrapper from "./components/modules/DashboardWrapper";
import { Toaster } from "./components/ui/Sonner";

const PUBLISHABLE_KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;
if (!PUBLISHABLE_KEY) {
  throw new Error("Missing VITE_CLERK_PUBLISHABLE_KEY");
}

const queryClient = new QueryClient();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ClerkProvider publishableKey={PUBLISHABLE_KEY} afterSignOutUrl="/sign-in">
    <Toaster />
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route path="/sign-in" element={<SignInPage />} />
          <Route path="/dashboard/*" element={<ProtectedRoute><DashboardRoutes /></ProtectedRoute>} />
          <Route
            path="*"
            element={<ProtectedRoute><Navigate replace to="/dashboard/calendar" /></ProtectedRoute>}
          />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
    </ClerkProvider>
  </React.StrictMode>,
);

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { isLoaded, isSignedIn } = useAuth();
  if (!isLoaded) return <div>Loading...</div>;
  if (!isSignedIn) return <Navigate replace to="/sign-in" />;
  return <>{children}</>;
}

function DashboardRoutes() {
  return (
    <DashboardWrapper>
      <Routes>
        <Route path="/" element={<Navigate replace to="/dashboard/calendar" />} />
        <Route path="calendar" element={<App />} />
        <Route path="notes" element={<NotesList />} />
        <Route path="notes/:botId" element={<TranscriptView />} />
        <Route path="knowledge-base" element={<KnowledgeBase />} />
        <Route path="transcripts" element={<NotesList />} />
        <Route path="instant-meeting" element={<InstantMeetingPage />} />
        <Route path="voice-agent" element={<VoiceAgentPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="voice-agent-settings" element={<VoiceAgentSettingsPage />} />
      </Routes>
    </DashboardWrapper>
  );
}
