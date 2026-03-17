import {
  Bell,
  BookOpen,
  Calendar,
  FileText,
  Home,
  Menu,
  Settings,
  Search,
  Users,
  Video,
  X,
  Loader2,
} from "lucide-react";
import { useState, useEffect } from "react";
import { Link, useLocation } from "react-router-dom";
import { toast } from "sonner";
import { cn } from "../../utils/cn";

type BotMode = "transcriptor" | "voice_agent";

interface KbDoc {
  id: string;
  title: string;
  is_active: boolean;
}

// Extend this array to add a 3rd option (e.g. LiveAvatar) in the future
const BOT_MODES: { value: BotMode; label: string }[] = [
  { value: "transcriptor", label: "Transcriptor" },
  { value: "voice_agent", label: "Voice Agent" },
  // { value: "live_avatar", label: "LiveAvatar" },
];

const SidebarItems = [
  { icon: Home, label: "Dashboard", href: "#sample-link" },
  { icon: Calendar, label: "Calendars", href: "/dashboard/calendar" },
  { icon: Video, label: "Meetings", href: "#sample-link-meetings" },
  { icon: FileText, label: "Notes", href: "/dashboard/notes" },
  { icon: BookOpen, label: "Knowledge Base", href: "/dashboard/knowledge-base" },
  { icon: Users, label: "Contacts", href: "#sample-link-contacts" },
  { icon: Settings, label: "Settings", href: "#sample-link-settings" },
];

function DashboardWrapper({ children }: { children: React.ReactNode }) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [showJoinDialog, setShowJoinDialog] = useState(false);
  const [meetingUrl, setMeetingUrl] = useState("");
  const [isJoining, setIsJoining] = useState(false);

  // ── Persisted bot settings ────────────────────────────────────────────────
  const [botMode, setBotMode] = useState<BotMode>("transcriptor");
  const [kbDocuments, setKbDocuments] = useState<KbDoc[]>([]);
  const [selectedKbId, setSelectedKbId] = useState<string>("");
  const [kbLoading, setKbLoading] = useState(false);

  const location = useLocation();

  // Load saved settings on mount
  useEffect(() => {
    fetch("/api/bot-settings")
      .then((r) => r.json())
      .then((s: { bot_mode: BotMode; active_kb_id: string | null }) => {
        setBotMode(s.bot_mode);
        if (s.active_kb_id) setSelectedKbId(s.active_kb_id);
      })
      .catch(console.error);
  }, []);

  // Fetch KB docs when voice_agent mode is active
  useEffect(() => {
    if (botMode !== "voice_agent") return;
    if (kbDocuments.length > 0) return; // already fetched
    setKbLoading(true);
    fetch("/api/kb")
      .then((r) => r.json())
      .then((data: { documents: KbDoc[] }) => {
        const docs = data.documents ?? [];
        setKbDocuments(docs);
        // Keep saved selection if still valid; otherwise default to first doc
        setSelectedKbId((prev) => {
          if (prev && docs.some((d) => d.id === prev)) return prev;
          return docs[0]?.id ?? "";
        });
      })
      .catch(console.error)
      .finally(() => setKbLoading(false));
  }, [botMode]);

  // ── Persist helpers ───────────────────────────────────────────────────────
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

  // ── Ad-hoc join ───────────────────────────────────────────────────────────
  const handleQuickJoin = async () => {
    if (!meetingUrl.trim()) return;
    setIsJoining(true);
    try {
      const res = await fetch("/api/bot/join", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // bot_type is omitted — backend reads it from persisted bot_settings
        body: JSON.stringify({ meeting_url: meetingUrl.trim() }),
      });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      toast.success(`Bot sent! ID: ${data.bot_id}`);
      setShowJoinDialog(false);
      setMeetingUrl("");
    } catch (err) {
      console.error(err);
      toast.error("Failed to send bot. Check the URL and try again.");
    } finally {
      setIsJoining(false);
    }
  };

  // ── Derived ───────────────────────────────────────────────────────────────
  const activeKbTitle = kbDocuments.find((d) => d.id === selectedKbId)?.title;

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Navbar */}
      <nav className="fixed top-0 left-0 right-0 h-14 bg-white border-b z-50 px-4">
        <div className="flex items-center justify-between h-full">
          <div className="flex items-center gap-4">
            <button
              onClick={() => setSidebarOpen(!sidebarOpen)}
              className="p-2 hover:bg-gray-100 rounded-md md:hidden"
            >
              {sidebarOpen ? (
                <X className="size-5" />
              ) : (
                <Menu className="size-5" />
              )}
            </button>
            <div className="flex items-center gap-2">
              <div className="size-8 bg-blue-600 rounded-lg flex items-center justify-center">
                <FileText className="size-4 text-white" />
              </div>
              <span className="font-semibold text-lg hidden sm:block">
                Weya Command Center
              </span>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <div className="relative hidden md:block">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-gray-400" />
              <input
                type="text"
                placeholder="Search..."
                className="pl-9 pr-4 py-1.5 text-sm border rounded-md w-64 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <button className="p-2 hover:bg-gray-100 rounded-md relative">
              <Bell className="size-5 text-gray-600" />
              <span className="absolute top-1 right-1 size-2 bg-red-500 rounded-full" />
            </button>
            <div className="size-8 bg-gray-200 rounded-full" />
          </div>
        </div>
      </nav>

      {/* Sidebar */}
      <aside
        className={cn(
          "fixed top-14 left-0 bottom-0 w-56 bg-white border-r z-40 transition-transform md:translate-x-0 flex flex-col",
          sidebarOpen ? "translate-x-0" : "-translate-x-full",
        )}
      >
        <div className="p-3 space-y-1 flex-1">
          {SidebarItems.map((item) => {
            const isActive = location.pathname === item.href;
            return (
              <Link
                key={item.href}
                to={item.href}
                className={cn(
                  "flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium transition-colors",
                  isActive
                    ? "bg-blue-50 text-blue-700"
                    : "text-gray-700 hover:bg-gray-100",
                )}
                onClick={() => setSidebarOpen(false)}
              >
                <item.icon className="size-4" />
                {item.label}
              </Link>
            );
          })}
        </div>

        {/* ── Bot Mode selector + Send Bot ─────────────────────────────── */}
        <div className="p-3 border-t space-y-2">
          <p className="text-xs font-medium text-gray-400 uppercase tracking-wide px-1">
            Bot Mode
          </p>

          {/* Segmented button group — add more options to BOT_MODES above */}
          <div className="flex rounded-md border overflow-hidden text-xs">
            {BOT_MODES.map((option, i) => (
              <button
                key={option.value}
                onClick={() => handleModeChange(option.value)}
                className={cn(
                  "flex-1 py-1.5 font-medium transition-colors",
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

          {/* Knowledge Base — shown only for Voice Agent mode */}
          {botMode === "voice_agent" && (
            <div>
              <p className="text-xs font-medium text-gray-400 uppercase tracking-wide px-1 mb-1">
                Knowledge Base
              </p>
              {kbLoading ? (
                <div className="flex items-center gap-1.5 text-xs text-gray-500 px-1 py-1">
                  <Loader2 className="size-3 animate-spin" />
                  Loading…
                </div>
              ) : (
                <select
                  value={selectedKbId}
                  onChange={(e) => handleKbChange(e.target.value)}
                  className="w-full px-2 py-1.5 border rounded-md text-xs focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
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
            </div>
          )}

          <button
            onClick={() => setShowJoinDialog(true)}
            className="flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium w-full bg-blue-600 text-white hover:bg-blue-700 transition-colors"
          >
            <Video className="size-4" />
            Send Bot to Meeting
          </button>
        </div>
      </aside>

      {/* Mobile overlay */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 bg-black/20 z-30 md:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Main content */}
      <main className="pt-14 md:pl-56">
        <div className="p-6">{children}</div>
      </main>

      {/* Quick Join Dialog */}
      {showJoinDialog && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-lg shadow-xl max-w-md w-full p-6">
            <h3 className="text-lg font-semibold mb-1">Send Bot to Meeting</h3>
            <p className="text-sm text-gray-500 mb-4">
              Paste a Zoom, Google Meet, or Teams link. The bot will join immediately.
            </p>

            {/* Read-only mode indicator — change it via the sidebar */}
            <div className="flex items-center gap-2 mb-4 px-3 py-2 bg-gray-50 rounded-md text-sm">
              <span
                className={cn(
                  "size-2 rounded-full flex-shrink-0",
                  botMode === "voice_agent" ? "bg-purple-500" : "bg-blue-500",
                )}
              />
              <span className="font-medium text-gray-700">
                {botMode === "voice_agent" ? "Voice Agent" : "Transcriptor"}
              </span>
              {botMode === "voice_agent" && activeKbTitle && (
                <span className="text-gray-400 text-xs truncate">· {activeKbTitle}</span>
              )}
              <span className="ml-auto text-xs text-gray-400 flex-shrink-0">
                Change in sidebar
              </span>
            </div>

            <input
              type="url"
              value={meetingUrl}
              onChange={(e) => setMeetingUrl(e.target.value)}
              placeholder="https://zoom.us/j/123456789..."
              className="w-full px-3 py-2 border rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 mb-4"
              autoFocus
              onKeyDown={(e) => e.key === "Enter" && handleQuickJoin()}
            />
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => { setShowJoinDialog(false); setMeetingUrl(""); }}
                className="px-4 py-2 text-sm rounded-md border hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                onClick={handleQuickJoin}
                disabled={isJoining || !meetingUrl.trim()}
                className="px-4 py-2 text-sm rounded-md bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 flex items-center gap-2"
              >
                {isJoining ? (
                  <>
                    <Loader2 className="size-4 animate-spin" />
                    Sending...
                  </>
                ) : (
                  "Send Bot"
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default DashboardWrapper;
