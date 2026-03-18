import { useState, useEffect } from "react";
import { Loader2, Zap } from "lucide-react";
import { toast } from "sonner";
import { cn } from "../utils/cn";
import { Card, CardContent } from "../components/ui/Card";

type BotMode = "transcriptor" | "voice_agent";

interface KbDoc {
  id: string;
  title: string;
  is_active: boolean;
}

const BOT_MODES: { value: BotMode; label: string }[] = [
  { value: "transcriptor", label: "Transcriptor" },
  { value: "voice_agent", label: "Voice Agent" },
];

export default function InstantMeetingPage() {
  const [botMode, setBotMode] = useState<BotMode>("transcriptor");
  const [kbDocuments, setKbDocuments] = useState<KbDoc[]>([]);
  const [selectedKbId, setSelectedKbId] = useState<string>("");
  const [kbLoading, setKbLoading] = useState(true);
  const [meetingUrl, setMeetingUrl] = useState("");
  const [isJoining, setIsJoining] = useState(false);

  // Load saved settings + KB docs together on mount
  useEffect(() => {
    Promise.all([
      fetch("/api/bot-settings").then((r) => r.json()) as Promise<{ bot_mode: BotMode; active_kb_id: string | null }>,
      fetch("/api/kb").then((r) => r.json()) as Promise<{ documents: KbDoc[] }>,
    ])
      .then(([settings, kbData]) => {
        setBotMode(settings.bot_mode);
        const docs = kbData.documents ?? [];
        setKbDocuments(docs);
        // Use saved KB id if valid, otherwise first doc
        const savedId = settings.active_kb_id;
        if (savedId && docs.some((d) => d.id === savedId)) {
          setSelectedKbId(savedId);
        } else if (docs.length > 0) {
          setSelectedKbId(docs[0].id);
        }
      })
      .catch(console.error)
      .finally(() => setKbLoading(false));
  }, []);

  const handleModeChange = (mode: BotMode) => {
    setBotMode(mode);
    fetch("/api/bot-settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bot_mode: mode }),
    }).catch(console.error);
  };

  const handleKbChange = (id: string) => {
    setSelectedKbId(id);
    fetch("/api/bot-settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ active_kb_id: id }),
    }).catch(console.error);
  };

  const handleSendBot = async () => {
    if (!meetingUrl.trim()) return;
    setIsJoining(true);
    try {
      const res = await fetch("/api/bot/join", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ meeting_url: meetingUrl.trim() }),
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

          {/* Knowledge Base — only relevant for Voice Agent mode */}
          {botMode === "voice_agent" && <div className="space-y-1.5">
            <p className="text-xs font-medium text-gray-400 uppercase tracking-wide">
              Knowledge Base
            </p>
            <p className="text-xs text-gray-500">
              Select the knowledge base for this meeting's Voice Agent
            </p>
            {kbLoading ? (
              <div className="flex items-center gap-2 text-sm text-gray-500 py-1">
                <Loader2 className="size-4 animate-spin" />
                Loading…
              </div>
            ) : (
              <select
                value={selectedKbId}
                onChange={(e) => handleKbChange(e.target.value)}
                className="w-full px-3 py-2 border rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
              >
                {kbDocuments.length === 0 ? (
                  <option value="">No knowledge bases</option>
                ) : (
                  kbDocuments.map((doc) => (
                    <option key={doc.id} value={doc.id}>
                      {doc.title}
                    </option>
                  ))
                )}
              </select>
            )}
          </div>}

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
