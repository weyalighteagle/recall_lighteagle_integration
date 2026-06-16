import { useState, useEffect } from "react";
import { useAuth } from "@clerk/react";
import { Loader2, Zap } from "lucide-react";
import { toast } from "sonner";
import { cn } from "../utils/cn";
import { Card, CardContent } from "../components/ui/Card";

type BotMode = "transcriptor" | "voice_agent";

interface Project {
  id: string;
  name: string;
  description: string | null;
  document_count: number;
}

interface SharedProject {
  id: string;
  name: string;
  description: string | null;
  owner_email: string;
}

const BOT_MODES: { value: BotMode; label: string }[] = [
  { value: "transcriptor", label: "Transcriptor" },
  { value: "voice_agent", label: "Voice Agent" },
];

export default function InstantMeetingPage() {
  const [botMode, setBotMode] = useState<BotMode>("transcriptor");
  const { getToken } = useAuth();
  const [projects, setProjects] = useState<Project[]>([]);
  const [sharedProjects, setSharedProjects] = useState<SharedProject[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string>("");
  const [projectsLoading, setProjectsLoading] = useState(true);
  const [meetingUrl, setMeetingUrl] = useState("");
  const [isJoining, setIsJoining] = useState(false);

  useEffect(() => {
    Promise.all([
      fetch("/api/bot-settings").then((r) => r.json()) as Promise<{ bot_mode: BotMode }>,
      getToken().then((token) =>
        fetch("/api/projects", {
          headers: { Authorization: `Bearer ${token}` },
        }).then((r) => r.json())
      ) as Promise<{ projects: Project[] }>,
      getToken().then((token) =>
        fetch("/api/projects/shared", {
          headers: { Authorization: `Bearer ${token}` },
        }).then((r) => r.json())
      ) as Promise<SharedProject[]>,
    ])
      .then(([settings, projectData, sharedData]) => {
        setBotMode(settings.bot_mode);
        setProjects(projectData.projects ?? []);
        // /api/projects/shared returns a bare array, not { projects: [...] }
        setSharedProjects(Array.isArray(sharedData) ? sharedData : []);
      })
      .catch(console.error)
      .finally(() => setProjectsLoading(false));
  }, []);

  const handleModeChange = (mode: BotMode) => {
    setBotMode(mode);
    fetch("/api/bot-settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bot_mode: mode }),
    }).catch(console.error);
  };

  const handleSendBot = async () => {
    if (!meetingUrl.trim()) return;
    setIsJoining(true);
    try {
      const token = await getToken();
      const body: Record<string, string> = { meeting_url: meetingUrl.trim() };
      if (botMode === "voice_agent" && selectedProjectId) {
        body.project_id = selectedProjectId;
      }
      const res = await fetch("/api/bot/join", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      toast.success(`Bot sent! ID: ${data.bot_id}`);
      setMeetingUrl("");
    } catch (err) {
      console.error(err);
      toast.error("Failed to send bot. Check the URL and try again.");
    } finally {
      setIsJoining(false);
    }
  };

  return (
    <div className="flex flex-col gap-4 max-w-xl mx-auto">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold flex items-center gap-2">
          <Zap className="size-5 text-blue-600" />
          Instant Meeting
        </h1>
      </div>
      <p className="text-sm text-gray-500 -mt-2">
        Send a bot to an ad-hoc meeting by pasting a Zoom link.
      </p>

      <Card>
        <CardContent className="pt-6 space-y-5">
          {/* Bot Mode */}
          <div className="space-y-2">
            <p className="text-xs font-medium text-gray-400 uppercase tracking-wide">
              Bot Mode
            </p>
            <div className="flex rounded-md border overflow-hidden text-sm">
              {BOT_MODES.map((option, i) => (
                <button
                  key={option.value}
                  onClick={() => handleModeChange(option.value)}
                  className={cn(
                    "flex-1 py-2 font-medium transition-colors",
                    i < BOT_MODES.length - 1 && "border-r",
                    botMode === option.value
                      ? "bg-blue-600 text-white"
                      : "bg-white text-gray-600 hover:bg-gray-50",
                  )}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>

          {/* Project — only for Voice Agent mode */}
          {botMode === "voice_agent" && (
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-gray-400 uppercase tracking-wide">
                Project
              </p>
              <p className="text-xs text-gray-500">
                Voice Agent will only search documents inside this project
              </p>
              {projectsLoading ? (
                <div className="flex items-center gap-2 text-sm text-gray-500 py-1">
                  <Loader2 className="size-4 animate-spin" />
                  Loading…
                </div>
              ) : (
                <select
                  value={selectedProjectId}
                  onChange={(e) => setSelectedProjectId(e.target.value)}
                  className="w-full px-3 py-2 border rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
                >
                  <option value="">No project — searches all active documents</option>
                  <optgroup label="My Projects">
                    {projects.map((project) => (
                      <option key={project.id} value={project.id}>
                        {project.name}{project.document_count > 0 ? ` (${project.document_count} docs)` : ""}
                      </option>
                    ))}
                  </optgroup>
                  {sharedProjects.length > 0 && (
                    <optgroup label="Shared with me">
                      {sharedProjects.map((project) => (
                        <option key={project.id} value={project.id}>
                          {project.name}
                        </option>
                      ))}
                    </optgroup>
                  )}
                </select>
              )}
            </div>
          )}

          {/* Meeting URL */}
          <div className="space-y-2">
            <p className="text-xs font-medium text-gray-400 uppercase tracking-wide">
              Meeting URL
            </p>
            <input
              type="url"
              value={meetingUrl}
              onChange={(e) => setMeetingUrl(e.target.value)}
              placeholder="https://zoom.us/j/123456789..."
              className="w-full px-3 py-2 border rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              onKeyDown={(e) => e.key === "Enter" && handleSendBot()}
            />
          </div>

          {/* Send Bot */}
          <button
            onClick={handleSendBot}
            disabled={isJoining || !meetingUrl.trim()}
            className="w-full px-4 py-2 text-sm rounded-md bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 flex items-center justify-center gap-2 transition-colors"
          >
            {isJoining ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                Sending…
              </>
            ) : (
              <>
                <Zap className="size-4" />
                Send Bot
              </>
            )}
          </button>
        </CardContent>
      </Card>
    </div>
  );
}
