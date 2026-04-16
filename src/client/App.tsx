import { useAuth, useUser } from "@clerk/react";
import {
    Calendar as CalendarIcon,
    Check,
    Clock,
    Download,
    FileText,
    Loader2,
    Mic,
    Plus,
    RefreshCw,
    Trash2,
    Video,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import type { CalendarType } from "../schemas/CalendarArtifactSchema";
import type { CalendarEventType } from "../schemas/CalendarEventArtifactSchema";
import { Button } from "./components/ui/Button";
import { Calendar } from "./components/ui/Calendar";
import { Card, CardContent } from "./components/ui/Card";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "./components/ui/Dialog";
import { ScrollArea } from "./components/ui/ScrollArea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./components/ui/Tabs";
import { useCalendar } from "./hooks/use-calendar";
import { useCalendarEvents } from "./hooks/use-calendar-events";
import { useDeleteCalendar } from "./hooks/use-delete-calendar";
import { useToggleRecording } from "./hooks/use-toggle-recording";
import { cn } from "./utils/cn";

function App() {
    const { isLoaded } = useAuth();
    const { user } = useUser();
    const { calendars, isPending } = useCalendar();

    if (!isLoaded || !user) return null;

    if (isPending) {
        return (
            <div className="flex items-center justify-center min-h-[60vh]">
                <div className="flex flex-col items-center gap-3 text-muted-foreground">
                    <RefreshCw className="size-5 animate-spin" />
                    <p className="text-sm">Loading calendars…</p>
                </div>
            </div>
        );
    }

    const filteredCalendars = calendars.filter(
        (cal) => !/(birthday|holiday)/i.test(cal.name ?? ""),
    );

    return (
        <>
            {filteredCalendars?.length ? (
                <CalendarList calendars={filteredCalendars} />
            ) : (
                <div className="flex items-center justify-center min-h-[60vh]">
                    <ConnectCalendar />
                </div>
            )}
        </>
    );
}

export default App;

function ConnectCalendar() {
    return (
        <div className="flex flex-col items-center gap-5 p-10 bg-card rounded-xl border border-border max-w-md">
            <div className="flex items-center justify-center size-12 rounded-full bg-brand-50">
                <CalendarIcon className="size-5 text-brand-700" />
            </div>
            <div className="text-center">
                <h2 className="text-lg font-semibold">No calendars connected</h2>
                <p className="text-sm text-muted-foreground mt-1 max-w-xs">
                    Connect your calendar to start scheduling bots for your meetings.
                </p>
            </div>
            <div className="flex flex-col sm:flex-row gap-2 w-full">
                <Button
                    className="flex-1"
                    variant="outline"
                    onClick={() => {
                        window.location.href = "/api/calendar/oauth?platform=google_calendar";
                    }}
                >
                    Connect Google
                </Button>
                <Button
                    className="flex-1"
                    variant="outline"
                    onClick={() => {
                        window.location.href = "/api/calendar/oauth?platform=microsoft_outlook";
                    }}
                >
                    Connect Outlook
                </Button>
            </div>
        </div>
    );
}

interface KbDoc {
    id: string;
    title: string;
    is_active: boolean;
}

function CalendarList({ calendars }: { calendars: CalendarType[] }) {
    const { user } = useUser();
    const [showConnectDialog, setShowConnectDialog] = useState(false);

    const [kbDocuments, setKbDocuments] = useState<KbDoc[]>([]);
    const [selectedKbId, setSelectedKbId] = useState<string>("");
    const [autoJoinEnabled, setAutoJoinEnabled] = useState<boolean>(true);

    useEffect(() => {
        Promise.all([
            fetch("/api/bot-settings").then((r) => r.json()) as Promise<{
                bot_mode: string;
                active_kb_id: string | null;
                auto_join_enabled?: boolean;
            }>,
            fetch("/api/kb").then((r) => r.json()) as Promise<{ documents: KbDoc[] }>,
        ])
            .then(([settings, kbData]) => {
                const docs = kbData.documents ?? [];
                setKbDocuments(docs);
                setAutoJoinEnabled(settings.auto_join_enabled ?? true);
                const savedId = settings.active_kb_id;
                if (savedId && docs.some((d) => d.id === savedId)) {
                    setSelectedKbId(savedId);
                } else if (docs.length > 0) {
                    setSelectedKbId(docs[0].id);
                }
            })
            .catch(console.error);
    }, []);

    const handleAutoJoinToggle = (enabled: boolean) => {
        setAutoJoinEnabled(enabled);
        fetch("/api/bot-settings", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ auto_join_enabled: enabled }),
        }).catch(console.error);
    };

    const calendarsByEmail = useMemo(() => {
        const userEmail = user?.primaryEmailAddress?.emailAddress;
        const filtered = calendars.filter((cal) => cal.platform_email === userEmail);
        const map = new Map<string, CalendarType[]>();
        for (const cal of filtered) {
            const key = cal.platform_email ?? cal.id;
            const existing = map.get(key) || [];
            existing.push(cal);
            map.set(key, existing);
        }
        return Array.from(map.entries()).map(([email, cals]) => ({
            email,
            calendars: cals,
            platform: cals[0].platform,
        }));
    }, [calendars, user]);

    const defaultTab = calendarsByEmail[0]?.email || "";

    return (
        <div className="flex flex-col gap-6">
            {/* Page header */}
            <div className="flex items-start justify-between gap-4 flex-wrap">
                <div>
                    <h1 className="text-2xl font-semibold tracking-tight">Calendars</h1>
                    <p className="text-sm text-muted-foreground mt-1">
                        Schedule bots automatically when meetings hit your calendar.
                    </p>
                </div>

                <div className="flex items-center gap-2 flex-wrap">
                    {/* Auto-join pill */}
                    <button
                        onClick={() => handleAutoJoinToggle(!autoJoinEnabled)}
                        className="flex items-center gap-2.5 h-9 px-3 text-sm border border-border rounded-md bg-card hover:bg-muted/50 transition-colors"
                        title={
                            autoJoinEnabled
                                ? "Auto-join is ON — bots join all meetings automatically"
                                : "Auto-join is OFF — schedule bots manually per meeting"
                        }
                    >
                        <span className="text-muted-foreground">Auto-join</span>
                        <Switch on={autoJoinEnabled} tone="success" />
                    </button>

                    <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setShowConnectDialog(true)}
                        className="h-9"
                    >
                        <Plus className="size-4" />
                        Add calendar
                    </Button>
                </div>

                <Dialog open={showConnectDialog} onOpenChange={setShowConnectDialog}>
                    <DialogContent>
                        <DialogHeader>
                            <DialogTitle>Connect another calendar</DialogTitle>
                            <DialogDescription>
                                Choose which calendar provider to connect.
                            </DialogDescription>
                        </DialogHeader>
                        <div className="flex flex-col gap-2">
                            <Button
                                variant="outline"
                                onClick={() => {
                                    window.location.href = "/api/calendar/oauth?platform=google_calendar";
                                }}
                            >
                                Connect Google Calendar
                            </Button>
                            <Button
                                variant="outline"
                                onClick={() => {
                                    window.location.href = "/api/calendar/oauth?platform=microsoft_outlook";
                                }}
                            >
                                Connect Microsoft Outlook
                            </Button>
                        </div>
                    </DialogContent>
                </Dialog>
            </div>

            {/* Tabs */}
            <Tabs defaultValue={defaultTab} className="w-full">
                <TabsList className="bg-transparent p-0 h-auto border-b border-border rounded-none w-full justify-start gap-1">
                    {calendarsByEmail.map((entry) => (
                        <TabsTrigger
                            key={entry.email}
                            value={entry.email}
                            className="rounded-none bg-transparent border-b-2 border-transparent data-[state=active]:border-brand-600 data-[state=active]:bg-transparent data-[state=active]:shadow-none px-3 py-2 text-sm font-medium text-muted-foreground data-[state=active]:text-foreground hover:text-foreground transition-colors"
                        >
                            {entry.email}
                        </TabsTrigger>
                    ))}
                </TabsList>

                {calendarsByEmail.map((entry) => (
                    <TabsContent key={entry.email} value={entry.email} className="mt-5">
                        <div className="flex flex-col gap-6">
                            {entry.calendars.map((calendar) => (
                                <CalendarDetails
                                    key={calendar.id}
                                    calendar={calendar}
                                    kbDocuments={kbDocuments}
                                    globalKbId={selectedKbId}
                                />
                            ))}
                        </div>
                    </TabsContent>
                ))}
            </Tabs>
        </div>
    );
}

function Switch({ on, tone = "brand" }: { on: boolean; tone?: "brand" | "success" | "danger" | "violet" }) {
    const toneClass = !on
        ? "bg-muted-foreground/30"
        : tone === "success"
            ? "bg-success"
            : tone === "danger"
                ? "bg-danger"
                : tone === "violet"
                    ? "bg-brand-400"
                    : "bg-brand-600";
    return (
        <span className={cn("relative inline-block w-8 h-[18px] rounded-full transition-colors", toneClass)}>
            <span
                className={cn(
                    "absolute top-[2px] size-3.5 bg-white rounded-full shadow-sm transition-transform",
                    on ? "translate-x-[14px]" : "translate-x-[2px]",
                )}
            />
        </span>
    );
}

function CalendarDetails({
    calendar,
    kbDocuments,
    globalKbId,
}: {
    calendar: CalendarType;
    kbDocuments: KbDoc[];
    globalKbId: string;
}) {
    const { user } = useUser();
    const [searchParams, setSearchParams] = useSearchParams();
    const [showDeleteDialog, setShowDeleteDialog] = useState(false);
    const { deleteCalendar, isDeleting } = useDeleteCalendar({ calendarId: calendar.id });

    const getLocalMidnightAsUTC = useCallback((dayOffset: number = 0) => {
        const now = new Date();
        return new Date(
            now.getFullYear(),
            now.getMonth(),
            now.getDate() + dayOffset,
            0, 0, 0, 0,
        ).toISOString();
    }, []);

    const selectedStartDate = useMemo(() => {
        const param = searchParams.get("start_time__gte");
        if (param) return param;
        return getLocalMidnightAsUTC(0);
    }, [searchParams, getLocalMidnightAsUTC]);

    const selectedEndDate = useMemo(() => {
        const param = searchParams.get("start_time__lte");
        if (param) return param;
        return getLocalMidnightAsUTC(1);
    }, [searchParams, getLocalMidnightAsUTC]);

    const handleDateSelect = useCallback(
        (date: Date) => {
            const y = date.getFullYear();
            const m = date.getMonth();
            const d = date.getDate();
            const startDate = new Date(y, m, d, 0, 0, 0, 0);
            const endDate = new Date(y, m, d + 1, 0, 0, 0, 0);

            setSearchParams(
                new URLSearchParams({
                    ...Object.fromEntries(searchParams.entries()),
                    start_time__gte: startDate.toISOString(),
                    start_time__lte: endDate.toISOString(),
                }),
            );
        },
        [searchParams, setSearchParams],
    );

    const latestStatus = calendar.status_changes.at(0)?.status ?? "connected";
    const latestStatusDate = calendar.status_changes.at(0)?.created_at;

    return (
        <div className="grid grid-cols-1 lg:grid-cols-[260px_minmax(0,1fr)] gap-5">
            {/* Left column */}
            <div className="flex flex-col gap-3">
                <Card className="py-0">
                    <CardContent className="p-3 flex justify-center">
                        <Calendar
                            mode="single"
                            required
                            selected={selectedStartDate ? new Date(selectedStartDate) : undefined}
                            onSelect={handleDateSelect}
                        />
                    </CardContent>
                </Card>

                {/* Connection status */}
                <Card className="py-0">
                    <CardContent className="p-4">
                        <div className="flex items-center justify-between mb-2">
                            <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                                Connection
                            </span>
                            <StatusPill status={latestStatus} />
                        </div>
                        <p className="text-sm font-medium truncate">{user?.primaryEmailAddress?.emailAddress}</p>
                        {latestStatusDate && (
                            <p className="text-xs text-muted-foreground mt-0.5">
                                {new Date(latestStatusDate).toLocaleString([], {
                                    month: "short",
                                    day: "numeric",
                                    hour: "2-digit",
                                    minute: "2-digit",
                                })}
                            </p>
                        )}

                        <div className="mt-3 pt-3 border-t border-border flex items-center justify-between">
                            <span className="text-xs text-muted-foreground">Disconnect calendar</span>
                            <button
                                onClick={() => setShowDeleteDialog(true)}
                                disabled={isDeleting}
                                className="p-1.5 rounded-md text-muted-foreground hover:text-danger hover:bg-danger-subtle transition-colors disabled:opacity-50"
                                aria-label="Disconnect calendar"
                            >
                                <Trash2 className="size-3.5" />
                            </button>
                        </div>
                    </CardContent>
                </Card>

                <Dialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
                    <DialogContent>
                        <DialogHeader>
                            <DialogTitle>Disconnect calendar</DialogTitle>
                            <DialogDescription>
                                Are you sure you want to disconnect{" "}
                                <span className="font-medium">{user?.primaryEmailAddress?.emailAddress}</span>? This
                                will stop syncing events from this calendar.
                            </DialogDescription>
                        </DialogHeader>
                        <DialogFooter>
                            <Button variant="outline" onClick={() => setShowDeleteDialog(false)}>
                                Cancel
                            </Button>
                            <Button
                                variant="destructive"
                                disabled={isDeleting}
                                onClick={() => {
                                    deleteCalendar();
                                    setShowDeleteDialog(false);
                                }}
                            >
                                {isDeleting ? "Disconnecting…" : "Disconnect"}
                            </Button>
                        </DialogFooter>
                    </DialogContent>
                </Dialog>
            </div>

            {/* Right column */}
            <CalendarEventsList
                calendar={calendar}
                startTimeGte={selectedStartDate}
                startTimeLte={selectedEndDate}
                kbDocuments={kbDocuments}
                globalKbId={globalKbId}
            />
        </div>
    );
}

function StatusPill({ status }: { status: string }) {
    const map: Record<string, { bg: string; text: string; dot: string; label: string }> = {
        connected: {
            bg: "bg-success-subtle",
            text: "text-success-strong",
            dot: "bg-success",
            label: "Connected",
        },
        connecting: {
            bg: "bg-warning-subtle",
            text: "text-warning-strong",
            dot: "bg-warning",
            label: "Connecting",
        },
        disconnected: {
            bg: "bg-muted",
            text: "text-muted-foreground",
            dot: "bg-muted-foreground/60",
            label: "Disconnected",
        },
    };
    const c = map[status] ?? map.disconnected;
    return (
        <span className={cn("inline-flex items-center gap-1.5 text-[11px] font-medium px-2 py-0.5 rounded-full", c.bg, c.text)}>
            <span className={cn("size-1.5 rounded-full", c.dot)} />
            {c.label}
        </span>
    );
}

function CalendarEventsList({
    calendar,
    startTimeGte,
    startTimeLte,
    kbDocuments,
    globalKbId,
}: {
    calendar: CalendarType;
    startTimeGte: string;
    startTimeLte: string;
    kbDocuments: KbDoc[];
    globalKbId: string;
}) {
    const latestStatus = calendar.status_changes.at(0)?.status;
    const isConnecting = latestStatus === "connecting";

    const { calendarEvents, isPending } = useCalendarEvents({
        calendarId: calendar.id,
        startTimeGte,
        startTimeLte,
    });

    const formatTime = (dateString: string) =>
        new Date(dateString).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

    const getEventTitle = (event: CalendarEventType) => {
        if (event.raw?.summary) return event.raw.summary;
        if (event.raw?.subject) return event.raw.subject;
        return "Untitled event";
    };

    const visibleEvents = calendarEvents.filter((e) => !e.is_deleted);
    const formattedDate = startTimeGte
        ? new Date(startTimeGte).toLocaleDateString([], {
            weekday: "long",
            month: "long",
            day: "numeric",
        })
        : "All events";

    return (
        <Card className="py-0">
            <CardContent className="p-5">
                <div className="flex items-center justify-between mb-4">
                    <div>
                        <h3 className="text-base font-semibold">{formattedDate}</h3>
                        <p className="text-xs text-muted-foreground mt-0.5">
                            {isConnecting
                                ? "Syncing calendar…"
                                : `${visibleEvents.length} event${visibleEvents.length !== 1 ? "s" : ""}`}
                        </p>
                    </div>
                </div>

                <ScrollArea className="h-[500px]">
                    {isConnecting ? (
                        <EmptyState
                            icon={<Loader2 className="size-6 text-warning animate-spin" />}
                            title="Connecting calendar…"
                            description="Please reload the page in a few seconds."
                        />
                    ) : isPending ? (
                        <EmptyState
                            icon={<Loader2 className="size-6 text-brand-600 animate-spin" />}
                            title="Loading events…"
                        />
                    ) : visibleEvents.length === 0 ? (
                        <EmptyState
                            icon={<CalendarIcon className="size-6 text-muted-foreground" />}
                            title="No events for this day"
                            description="Pick another date, or wait for new meetings to sync."
                        />
                    ) : (
                        <div className="space-y-2 pr-3">
                            {visibleEvents.map((event) => (
                                <CalendarEventCard
                                    key={event.id}
                                    event={event}
                                    calendarId={calendar.id}
                                    formatTime={formatTime}
                                    getEventTitle={getEventTitle}
                                    kbDocuments={kbDocuments}
                                    globalKbId={globalKbId}
                                />
                            ))}
                        </div>
                    )}
                </ScrollArea>
            </CardContent>
        </Card>
    );
}

function EmptyState({
    icon,
    title,
    description,
}: {
    icon: React.ReactNode;
    title: string;
    description?: string;
}) {
    return (
        <div className="flex flex-col items-center justify-center py-16 text-center">
            <div className="flex items-center justify-center size-12 rounded-full bg-muted mb-3">{icon}</div>
            <p className="text-sm font-medium">{title}</p>
            {description && <p className="text-xs text-muted-foreground mt-1 max-w-xs">{description}</p>}
        </div>
    );
}

function CalendarEventCard({
    event,
    calendarId: _calendarId,
    formatTime,
    getEventTitle,
    kbDocuments,
    globalKbId,
}: {
    event: CalendarEventType;
    calendarId: string;
    formatTime: (s: string) => string;
    getEventTitle: (e: CalendarEventType) => string;
    kbDocuments: KbDoc[];
    globalKbId: string;
}) {
    const { scheduleRecording, unscheduleRecording, isPending: isRecordingPending } = useToggleRecording({
        calendarId: _calendarId,
        calendarEventId: event.id,
        botType: "recording",
    });

    const {
        scheduleRecording: scheduleVoiceAgent,
        unscheduleRecording: unscheduleVoiceAgent,
        isPending: isVoiceAgentPending,
    } = useToggleRecording({
        calendarId: _calendarId,
        calendarEventId: event.id,
        botType: "voice_agent",
    });

    const navigate = useNavigate();
    const [isExporting, setIsExporting] = useState(false);
    const [eventKbId, setEventKbId] = useState<string | null | undefined>(undefined);

    const isInFuture = new Date(event.start_time) > new Date();
    const hasMeetingUrl = !!event.meeting_url;
    const canToggle = isInFuture && hasMeetingUrl;

    useEffect(() => {
        if (!canToggle || kbDocuments.length === 0) {
            setEventKbId(null);
            return;
        }
        fetch(`/api/meeting-kb/${event.id}`)
            .then((r) => r.json())
            .then((data: { kb_document_id: string | null }) => setEventKbId(data.kb_document_id))
            .catch(() => setEventKbId(null));
    }, [event.id, canToggle, kbDocuments.length]);

    const handleKbChange = (id: string) => {
        setEventKbId(id);
        fetch(`/api/meeting-kb/${event.id}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ kb_document_id: id }),
        }).catch(console.error);
    };

    const handleExportTranscript = async (botId: string) => {
        setIsExporting(true);
        try {
            const res = await fetch(`/api/transcripts/${botId}`);
            if (!res.ok) throw new Error(await res.text());
            const data: {
                utterances: { participant: string; words: { text: string }[]; timestamp: string }[];
                done: boolean;
            } = await res.json();
            const lines = data.utterances.map((u) => {
                const time = new Date(u.timestamp).toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                    second: "2-digit",
                });
                const text = u.words.map((w) => w.text).join(" ");
                return `[${time}] ${u.participant}: ${text}`;
            });
            const blob = new Blob([lines.join("\n")], { type: "text/plain;charset=utf-8" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = `transcript-${botId}.txt`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        } catch (err) {
            console.error("Failed to export transcript:", err);
        } finally {
            setIsExporting(false);
        }
    };

    const hasRecordingBot = event.bots.some(
        (bot) => bot.deduplication_key.startsWith("rec-") && new Date(bot.start_time) > new Date(),
    );
    const hasVoiceAgentBot = event.bots.some(
        (bot) => bot.deduplication_key.startsWith("va-") && new Date(bot.start_time) > new Date(),
    );
    const hasLegacyBot = event.bots.some(
        (bot) =>
            !bot.deduplication_key.startsWith("rec-") &&
            !bot.deduplication_key.startsWith("va-") &&
            new Date(bot.start_time) > new Date(),
    );
    const isRecordingScheduled = hasRecordingBot || hasLegacyBot;

    const handleRecordingToggle = () => {
        if (isRecordingPending) return;
        if (isRecordingScheduled) unscheduleRecording();
        else scheduleRecording();
    };

    const handleVoiceAgentToggle = () => {
        if (isVoiceAgentPending) return;
        if (hasVoiceAgentBot) unscheduleVoiceAgent();
        else scheduleVoiceAgent();
    };

    // Accent bar color
    const accentClass = !isInFuture
        ? "bg-muted-foreground/40"
        : hasVoiceAgentBot
            ? "bg-brand-400"
            : isRecordingScheduled
                ? "bg-danger"
                : "bg-brand-600";

    const hasBots = event.bots.length > 0;

    return (
        <div
            className={cn(
                "rounded-lg border border-border bg-card p-3.5 transition-colors hover:border-border/80",
                !isInFuture && "opacity-60",
            )}
        >
            <div className="flex items-start gap-3">
                {/* Accent bar */}
                <div className={cn("w-[3px] self-stretch rounded-full shrink-0", accentClass)} />

                <div className="flex-1 min-w-0">
                    <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                            <p className="text-sm font-medium truncate">{getEventTitle(event)}</p>
                            <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground flex-wrap">
                                <span className="inline-flex items-center gap-1">
                                    <Clock className="size-3" />
                                    {formatTime(event.start_time)} – {formatTime(event.end_time)}
                                </span>
                                {event.meeting_url ? (

                                    href = { event.meeting_url }
                    target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-1 text-brand-700 hover:text-brand-800 hover:underline max-w-[260px] truncate"
                  >
                                <Video className="size-3 shrink-0" />
                                <span className="truncate">{event.meeting_url.replace(/^https?:\/\//, "")}</span>
                            </a>
                            ) : (
                            <span className="text-muted-foreground/70">No meeting link</span>
                )}
                        </div>
                    </div>

                    {/* Toggles */}
                    {canToggle ? (
                        <div className="flex flex-col gap-1.5 items-end shrink-0">
                            <ToggleRow
                                label="Transcript"
                                on={isRecordingScheduled}
                                pending={isRecordingPending}
                                onToggle={handleRecordingToggle}
                                tone="danger"
                            />
                            <ToggleRow
                                label="Voice agent"
                                on={hasVoiceAgentBot}
                                pending={isVoiceAgentPending}
                                onToggle={handleVoiceAgentToggle}
                                tone="violet"
                            />
                        </div>
                    ) : !isInFuture ? (
                        <span className="text-[11px] font-medium text-muted-foreground px-2 py-0.5 rounded-full bg-muted shrink-0">
                            Past
                        </span>
                    ) : null}
                </div>

                {/* Footer row */}
                {(canToggle && kbDocuments.length > 0) || hasBots ? (
                    <div className="mt-3 pt-3 border-t border-dashed border-border flex items-center gap-3 flex-wrap">
                        {canToggle && kbDocuments.length > 0 && (
                            <div className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                                <span>KB</span>
                                {eventKbId === undefined ? (
                                    <Loader2 className="size-3 animate-spin" />
                                ) : (
                                    <select
                                        value={eventKbId ?? globalKbId}
                                        onChange={(e) => handleKbChange(e.target.value)}
                                        className="text-xs border border-border rounded-md px-2 py-0.5 bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-ring max-w-[180px]"
                                    >
                                        {kbDocuments.map((doc) => (
                                            <option key={doc.id} value={doc.id}>
                                                {doc.title}
                                                {doc.id === globalKbId ? " (default)" : ""}
                                            </option>
                                        ))}
                                    </select>
                                )}
                            </div>
                        )}

                        {isRecordingScheduled && (
                            <Badge tone="danger">
                                <Video className="size-3" /> Recording
                            </Badge>
                        )}
                        {hasVoiceAgentBot && (
                            <Badge tone="brand">
                                <Mic className="size-3" /> Voice agent
                            </Badge>
                        )}

                        {hasBots && (
                            <div className="ml-auto flex items-center gap-3">
                                <button
                                    onClick={() => navigate(`/dashboard/notes/${event.bots[0].bot_id}`)}
                                    className="inline-flex items-center gap-1 text-xs text-brand-700 hover:text-brand-800 hover:underline"
                                >
                                    <FileText className="size-3" />
                                    View notes
                                </button>
                                <button
                                    onClick={() => handleExportTranscript(event.bots[0].bot_id)}
                                    disabled={isExporting}
                                    className="inline-flex items-center gap-1 text-xs text-brand-700 hover:text-brand-800 hover:underline disabled:opacity-50"
                                >
                                    {isExporting ? (
                                        <Loader2 className="size-3 animate-spin" />
                                    ) : (
                                        <Download className="size-3" />
                                    )}
                                    Export
                                </button>
                            </div>
                        )}
                    </div>
                ) : null}
            </div>
        </div>
    </div >
  );
}

function ToggleRow({
    label,
    on,
    pending,
    onToggle,
    tone,
}: {
    label: string;
    on: boolean;
    pending: boolean;
    onToggle: () => void;
    tone: "danger" | "violet";
}) {
    return (
        <button
            onClick={onToggle}
            disabled={pending}
            className="inline-flex items-center gap-2 group disabled:opacity-60"
            title={on ? `Turn off ${label.toLowerCase()}` : `Turn on ${label.toLowerCase()}`}
        >
            <span className="text-[11px] text-muted-foreground group-hover:text-foreground transition-colors">
                {label}
            </span>
            <span className="min-w-[32px] flex items-center justify-center">
                {pending ? (
                    <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
                ) : (
                    <Switch on={on} tone={tone === "danger" ? "danger" : "violet"} />
                )}
            </span>
        </button>
    );
}

function Badge({
    children,
    tone,
}: {
    children: React.ReactNode;
    tone: "brand" | "danger" | "success" | "muted";
}) {
    const toneClass =
        tone === "brand"
            ? "bg-brand-50 text-brand-800"
            : tone === "danger"
                ? "bg-danger-subtle text-danger-strong"
                : tone === "success"
                    ? "bg-success-subtle text-success-strong"
                    : "bg-muted text-muted-foreground";
    return (
        <span className={cn("inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-full", toneClass)}>
            {children}
        </span>
    );
}

// Unused but kept for TS cleanliness if referenced elsewhere
export { Check };