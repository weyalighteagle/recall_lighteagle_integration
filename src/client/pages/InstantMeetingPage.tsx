import { useState, useEffect } from "react";
import { useAuth } from "@clerk/react";
import { Loader2, Zap } from "lucide-react";
import { toast } from "sonner";
import { cn } from "../utils/cn";
import { Card, CardContent } from "../components/ui/Card";

type BotMode = "transcriptor" | "voice_agent";

interface KbTag {
  id: string;
  name: string;
  color: string | null;
}

const BOT_MODES: { value: BotMode; label: string }[] = [
  { value: "transcriptor", label: "Transcriptor" },
  { value: "voice_agent", label: "Voice Agent" },
];

export default function InstantMeetingPage() {
  const [botMode, setBotMode] = useState<BotMode>("transcriptor");
  const { getToken } = useAuth();
  const [tags, setTags] = useState<KbTag[]>([]);
  const [selectedTagId, setSelectedTagId] = useState<string>("");
  const [tagsLoading, setTagsLoading] = useState(true);
  const [meetingUrl, setMeetingUrl] = useState("");
  const [isJoining, setIsJoining] = useState(false);

  useEffect(() => {
    Promise.all([
      fetch("/api/bot-settings").then((r) => r.json()) as Promise<{ bot_mode: BotMode }>,
      getToken().then((token) =>
        fetch("/api/kb/tags", {
          headers: { Authorization: `Bearer ${token}` },
        }).then((r) => r.json())
      ) as Promise<{ tags: KbTag[] }>,
    ])
      .then(([settings, tagData]) => {
        setBotMode(settings.bot_mode);
        setTags(tagData.tags ?? []);
      })
      .catch(console.error)
      .finally(() => setTagsLoading(false));
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
      const res = await fetch("/api/bot/join", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ meeting_url: meetingUrl.trim() }),
      });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();

      if (botMode === "voice_agent" && selectedTagId && data.bot_id) {
        await fetch(`/api/meetings/${data.bot_id}/tags`, {
          method: "PUT",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ tag_ids: [selectedTagId] }),
        }).catch(console.error);
      }

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

          {/* Category — only for Voice Agent mode */}
          {botMode === "voice_agent" && (
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-gray-400 uppercase tracking-wide">
                Category
              </p>
              <p className="text-xs text-gray-500">
                Voice Agent will only answer from this category&apos;s documents
              </p>
              {tagsLoading ? (
                <div className="flex items-center gap-2 text-sm text-gray-500 py-1">
                  <Loader2 className="size-4 animate-spin" />
                  Loading…
                </div>
              ) : (
                <select
                  value={selectedTagId}
                  onChange={(e) => setSelectedTagId(e.target.value)}
                  className="w-full px-3 py-2 border rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
                >
                  <option value="">No filter — answers from all documents</option>
                  {tags.map((tag) => (
                    <option key={tag.id} value={tag.id}>
                      {tag.name}
                    </option>
                  ))}
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
