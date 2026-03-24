import { useAuth, useUser } from "@clerk/react";
import {
    Calendar as CalendarIcon,
    Clock,
    Download,
    FileText,
    Mic,
    Video,
    Trash2,
    Loader2,
    RefreshCw,
    Plus,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import type { CalendarType } from "../schemas/CalendarArtifactSchema";
import type { CalendarEventType } from "../schemas/CalendarEventArtifactSchema";
import { Button } from "./components/ui/Button";
import { Calendar } from "./components/ui/Calendar";
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from "./components/ui/Card";
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

function App() {
    const { isLoaded } = useAuth();
    const { user } = useUser();
    const { calendars, isPending } = useCalendar();

    if (!isLoaded || !user) return null;

    if (isPending) {
        return (
            <div className="flex items-center justify-center min-h-[60vh]">
                <div className="flex flex-col items-center gap-3 text-gray-500">
                    <RefreshCw className="size-6 animate-spin" />
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
        <div className="flex flex-col items-center gap-4 p-8 bg-white rounded-lg border shadow-sm max-w-md">
            <div className="flex items-center justify-center size-12 bg-gray-100 rounded-full">
                <CalendarIcon className="size-6 text-gray-600" />
            </div>
            <div className="text-center">
                <h2 className="text-lg font-semibold">
                    No calendars connected
                </h2>
                <p className="text-sm text-gray-500 mt-1">
                    Connect your calendar to start scheduling bots for your
                    meetings.
                </p>
            </div>
            <div className="flex flex-col sm:flex-row gap-2 w-full">
                <Button
                    className="flex-1"
                    variant="outline"
                    onClick={() => {
                        window.location.href =
                            "/api/calendar/oauth?platform=google_calendar";
                    }}
                >
                    Connect Google
                </Button>
                <Button
                    className="flex-1"
                    variant="outline"
                    onClick={() => {
                        window.location.href =
                            "/api/calendar/oauth?platform=microsoft_outlook";
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

    // ── KB data — needed by per-meeting KB dropdowns on event cards ──────────
    const [kbDocuments, setKbDocuments] = useState<KbDoc[]>([]);
    const [selectedKbId, setSelectedKbId] = useState<string>("");

    useEffect(() => {
        Promise.all([
            fetch("/api/bot-settings").then((r) => r.json()) as Promise<{ bot_mode: string; active_kb_id: string | null }>,
            fetch("/api/kb").then((r) => r.json()) as Promise<{ documents: KbDoc[] }>,
        ])
            .then(([settings, kbData]) => {
                const docs = kbData.documents ?? [];
                setKbDocuments(docs);
                const savedId = settings.active_kb_id;
                if (savedId && docs.some((d) => d.id === savedId)) {
                    setSelectedKbId(savedId);
                } else if (docs.length > 0) {
                    setSelectedKbId(docs[0].id);
                }
            })
            .catch(console.error);
    }, []);

    // Her email adresi için ayrı tab
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
        <div className="flex flex-col gap-4">
            <div className="flex items-center justify-between">
                <h1 className="text-lg font-semibold">Your Calendars</h1>
                <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setShowConnectDialog(true)}
                    className="flex items-center gap-1"
                >
                    <Plus className="size-4" />
                    Add Calendar
                </Button>

                <Dialog open={showConnectDialog} onOpenChange={setShowConnectDialog}>
                    <DialogContent>
                        <DialogHeader>
                            <DialogTitle>Connect Another Calendar</DialogTitle>
                            <DialogDescription>
                                Choose which calendar provider to connect.
                            </DialogDescription>
                        </DialogHeader>
                        <div className="flex flex-col gap-2">
                            <Button
                                variant="outline"
                                onClick={() => {
                                    window.location.href =
                                        "/api/calendar/oauth?platform=google_calendar";
                                }}
                            >
                                Connect Google Calendar
                            </Button>
                            <Button
                                variant="outline"
                                onClick={() => {
                                    window.location.href =
                                        "/api/calendar/oauth?platform=microsoft_outlook";
                                }}
                            >
                                Connect Microsoft Outlook
                            </Button>
                        </div>
                    </DialogContent>
                </Dialog>
            </div>

            <Tabs defaultValue={defaultTab} className="w-full">
                <TabsList>
                    {calendarsByEmail.map((entry) => (
                        <TabsTrigger key={entry.email} value={entry.email}>
                            {entry.email}
                        </TabsTrigger>
                    ))}
                </TabsList>

                {calendarsByEmail.map((entry) => (
                    <TabsContent key={entry.email} value={entry.email}>
                        <div className="flex flex-col gap-6 mt-4">
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

function CalendarDetails({ calendar, kbDocuments, globalKbId }: { calendar: CalendarType; kbDocuments: KbDoc[]; globalKbId: string }) {
    const { user } = useUser();
    const [searchParams, setSearchParams] = useSearchParams();
    const [showDeleteDialog, setShowDeleteDialog] = useState(false);
    const { deleteCalendar, isDeleting } = useDeleteCalendar({
        calendarId: calendar.id,
    });

    // Helper to get local midnight as UTC ISO string
    const getLocalMidnightAsUTC = useCallback((dayOffset: number = 0) => {
        const now = new Date();
        // Create a date at local midnight, then convert to UTC via toISOString()
        return new Date(
            now.getFullYear(),
            now.getMonth(),
            now.getDate() + dayOffset,
            0,
            0,
            0,
            0,
        ).toISOString();
    }, []);

    const selectedStartDate = useMemo(() => {
        const param = searchParams.get("start_time__gte");
        if (param) return param;
        // Default to local midnight today (expressed in UTC)
        return getLocalMidnightAsUTC(0);
    }, [searchParams, getLocalMidnightAsUTC]);

    const selectedEndDate = useMemo(() => {
        const param = searchParams.get("start_time__lte");
        if (param) return param;
        // Default to local midnight tomorrow (expressed in UTC)
        return getLocalMidnightAsUTC(1);
    }, [searchParams, getLocalMidnightAsUTC]);

    const handleDateSelect = useCallback(
        (date: Date) => {
            // Create dates at local midnight for the selected date and next day
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

    return (
        <div className="flex flex-col lg:flex-row gap-4">
            {/* Left Column - Calendar Details */}
            <div className="flex flex-col gap-4 min-w-[320px] shrink-0">
                {/* Calendar Date Picker */}
                <Card>
                    <CardContent className="p-4 flex justify-center">
                        <Calendar
                            mode="single"
                            required
                            selected={
                                selectedStartDate
                                    ? new Date(selectedStartDate)
                                    : undefined
                            }
                            onSelect={handleDateSelect}
                        />
                    </CardContent>
                </Card>

                {/* Calendar Status Card */}
                <Card>
                    <CardHeader>
                        <div className="flex flex-col w-full">
                            <div className="flex items-center justify-between w-full gap-3">
                                <CardTitle className="text-base">
                                    {user?.primaryEmailAddress?.emailAddress}
                                </CardTitle>

                                <Button
                                    variant="ghost"
                                    size="sm"
                                    disabled={isDeleting}
                                    onClick={() => setShowDeleteDialog(true)}
                                    className="text-red-500 hover:text-red-700 hover:bg-red-50"
                                >
                                    <Trash2 className="size-4" />
                                </Button>

                                <Dialog
                                    open={showDeleteDialog}
                                    onOpenChange={setShowDeleteDialog}
                                >
                                    <DialogContent>
                                        <DialogHeader>
                                            <DialogTitle>
                                                Disconnect Calendar
                                            </DialogTitle>
                                            <DialogDescription>
                                                Are you sure you want to
                                                disconnect{" "}
                                                <span className="font-medium">
                                                    {user?.primaryEmailAddress?.emailAddress}
                                                </span>
                                                ? This will stop syncing events
                                                from this calendar.
                                            </DialogDescription>
                                        </DialogHeader>
                                        <DialogFooter>
                                            <Button
                                                variant="outline"
                                                onClick={() =>
                                                    setShowDeleteDialog(false)
                                                }
                                            >
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
                                                {isDeleting
                                                    ? "Disconnecting..."
                                                    : "Disconnect"}
                                            </Button>
                                        </DialogFooter>
                                    </DialogContent>
                                </Dialog>
                            </div>
                        </div>
                    </CardHeader>
                    <CardContent>
                        <div className="space-y-2">
                            <h4 className="text-sm font-medium text-gray-700">
                                Status History
                            </h4>
                            <div className="space-y-1 max-h-48 overflow-y-auto">
                                {[...calendar.status_changes]
                                    .reverse()
                                    .map((change, index) => {
                                        const isConnected =
                                            change.status === "connected";
                                        return (
                                            <div
                                                key={index}
                                                className={`flex items-center justify-between text-sm py-1.5 px-2 rounded ${
                                                    isConnected
                                                        ? "bg-green-50"
                                                        : "bg-gray-50"
                                                }`}
                                            >
                                                <span
                                                    className={`capitalize ${
                                                        isConnected
                                                            ? "text-green-700 font-medium"
                                                            : "text-gray-400"
                                                    }`}
                                                >
                                                    {change.status}
                                                </span>
                                                <span
                                                    className={`text-xs ${
                                                        isConnected
                                                            ? "text-green-600"
                                                            : "text-gray-400"
                                                    }`}
                                                >
                                                    {new Date(
                                                        change.created_at,
                                                    ).toLocaleString()}
                                                </span>
                                            </div>
                                        );
                                    })}
                            </div>
                        </div>
                    </CardContent>
                </Card>
            </div>

            {/* Right Column - Events List */}
            <div className="flex flex-col gap-4 flex-1 min-w-0">
                <CalendarEventsList
                    calendar={calendar}
                    startTimeGte={selectedStartDate}
                    startTimeLte={selectedEndDate}
                    kbDocuments={kbDocuments}
                    globalKbId={globalKbId}
                />
            </div>
        </div>
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
        startTimeGte: startTimeGte,
        startTimeLte: startTimeLte,
    });

    const formatTime = (dateString: string) => {
        return new Date(dateString).toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
        });
    };

    const getEventTitle = (event: CalendarEventType) => {
        // Try to extract title from raw data
        if (event.raw?.summary) return event.raw.summary;
        if (event.raw?.subject) return event.raw.subject;
        return "Untitled Event";
    };

    return (
        <Card>
            <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center gap-2">
                    <Clock className="size-4" />
                    Events for{" "}
                    {startTimeGte
                        ? new Date(startTimeGte).toLocaleDateString()
                        : "all time"}
                </CardTitle>
                <CardDescription>
                    {isConnecting
                        ? "Syncing calendar..."
                        : `${calendarEvents.length} event${
                              calendarEvents.length !== 1 ? "s" : ""
                          } scheduled`}
                </CardDescription>
            </CardHeader>
            <CardContent>
                <ScrollArea className="h-[400px] lg:h-[500px]">
                    {isConnecting ? (
                        <div className="flex flex-col items-center justify-center h-full text-center py-8">
                            <Loader2 className="size-8 text-yellow-500 mb-3 animate-spin" />
                            <p className="text-sm font-medium text-gray-700">
                                Connecting calendar...
                            </p>
                            <p className="text-xs text-gray-500 mt-1">
                                Please reload the page in a few seconds
                            </p>
                        </div>
                    ) : isPending ? (
                        <div className="flex flex-col items-center justify-center h-full text-center py-8">
                            <Loader2 className="size-8 text-blue-500 mb-3 animate-spin" />
                            <p className="text-sm font-medium text-gray-700">
                                Loading events...
                            </p>
                        </div>
                    ) : calendarEvents.length === 0 ? (
                        <div className="flex flex-col items-center justify-center h-full text-center py-8">
                            <CalendarIcon className="size-8 text-gray-300 mb-2" />
                            <p className="text-sm text-gray-500">
                                No events for this day
                            </p>
                        </div>
                    ) : (
                        <div className="space-y-3 pr-4">
                            {calendarEvents
                                .filter((event) => !event.is_deleted)
                                .map((event) => (
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

function CalendarEventCard({
    event,
    calendarId,
    formatTime,
    getEventTitle,
    kbDocuments,
    globalKbId,
}: {
    event: CalendarEventType;
    calendarId: string;
    formatTime: (dateString: string) => string;
    getEventTitle: (event: CalendarEventType) => string;
    kbDocuments: KbDoc[];
    globalKbId: string;
}) {
    // Recording bot toggle hook
    const {
        scheduleRecording,
        unscheduleRecording,
        isPending: isRecordingPending,
    } = useToggleRecording({
        calendarId,
        calendarEventId: event.id,
        botType: "recording",
    });

    // Voice agent bot toggle hook
    const {
        scheduleRecording: scheduleVoiceAgent,
        unscheduleRecording: unscheduleVoiceAgent,
        isPending: isVoiceAgentPending,
    } = useToggleRecording({
        calendarId,
        calendarEventId: event.id,
        botType: "voice_agent",
    });

    const navigate = useNavigate();
    const [isExporting, setIsExporting] = useState(false);
    // undefined = still loading, null = no override set
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
            const data: { utterances: { participant: string; words: { text: string }[]; timestamp: string }[]; done: boolean } = await res.json();
            const lines = data.utterances.map((u) => {
                const time = new Date(u.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
                const text = u.words.map((w) => w.text).join(" ");
                return `[${time}] ${u.participant}: ${text}`;
            });
            const content = lines.join("\n");
            const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
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

    // Dedup key prefix'ine bakarak bot tipini tespit et
    const hasRecordingBot = event.bots.some(
        (bot) => bot.deduplication_key.startsWith("rec-") && new Date(bot.start_time) > new Date(),
    );
    const hasVoiceAgentBot = event.bots.some(
        (bot) => bot.deduplication_key.startsWith("va-") && new Date(bot.start_time) > new Date(),
    );

    // Geriye uyumluluk: eski format prefix'siz dedup key'ler recording sayılır
    const hasLegacyBot = event.bots.some(
        (bot) =>
            !bot.deduplication_key.startsWith("rec-") &&
            !bot.deduplication_key.startsWith("va-") &&
            new Date(bot.start_time) > new Date(),
    );
    const isRecordingScheduled = hasRecordingBot || hasLegacyBot;

    const handleRecordingToggle = () => {
        if (isRecordingPending) return;
        if (isRecordingScheduled) {
            unscheduleRecording();
        } else {
            scheduleRecording();
        }
    };

    const handleVoiceAgentToggle = () => {
        if (isVoiceAgentPending) return;
        if (hasVoiceAgentBot) {
            unscheduleVoiceAgent();
        } else {
            scheduleVoiceAgent();
        }
    };

    // Tek toggle satırı render eden yardımcı
    const renderToggle = (
        label: string,
        isActive: boolean,
        isPending: boolean,
        onToggle: () => void,
        activeColor: string,  // tailwind renk sınıfı, ör: "bg-red-500"
    ) => (
        <button
            onClick={onToggle}
            disabled={isPending}
            className="shrink-0 flex items-center gap-2 group"
            title={isActive ? `Turn off ${label}` : `Turn on ${label}`}
        >
            <span className="text-xs text-gray-500 group-hover:text-gray-700">
                {label}
            </span>
            <span className="min-w-9 min-h-5 flex items-center justify-center">
                {isPending ? (
                    <Loader2 className="size-4 animate-spin text-gray-400" />
                ) : (
                    <div
                        className={`relative w-9 h-5 rounded-full transition-colors ${
                            isActive ? activeColor : "bg-gray-300"
                        }`}
                    >
                        <div
                            className={`absolute top-0.5 size-4 bg-white rounded-full shadow transition-transform ${
                                isActive ? "translate-x-4" : "translate-x-0.5"
                            }`}
                        />
                    </div>
                )}
            </span>
        </button>
    );

    return (
        <div className="flex flex-col gap-1.5 p-4 rounded-lg bg-gray-50 hover:bg-gray-100 transition-colors">
            <div className="flex items-start justify-between gap-2">
                <h4 className="text-sm font-medium flex-1">
                    {getEventTitle(event)}
                </h4>

                {/* Toggle'lar — sağ üst köşe */}
                {canToggle ? (
                    <div className="flex flex-col gap-1.5 shrink-0 items-end">
                        {renderToggle("Transcriptor", isRecordingScheduled, isRecordingPending, handleRecordingToggle, "bg-red-500")}
                        {renderToggle("Voice Agent", hasVoiceAgentBot, isVoiceAgentPending, handleVoiceAgentToggle, "bg-purple-500")}
                    </div>
                ) : !hasMeetingUrl ? (
                    <span className="shrink-0 text-xs text-gray-400">
                        No meeting link
                    </span>
                ) : !isInFuture ? (
                    <span className="shrink-0 text-xs text-gray-400">Past</span>
                ) : null}
            </div>

            <div className="flex flex-col gap-1 text-xs text-gray-500">
                <span className="flex items-center gap-1">
                    <Clock className="size-3" />
                    {formatTime(event.start_time)} -{" "}
                    {formatTime(event.end_time)}
                </span>
                {event.meeting_url && (
                    <a
                        href={event.meeting_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-1 text-blue-600 hover:text-blue-800 hover:underline truncate"
                    >
                        <Video className="size-3 shrink-0" />
                        <span className="truncate">{event.meeting_url}</span>
                    </a>
                )}
                {canToggle && kbDocuments.length > 0 && (
                    <div className="flex items-center gap-1.5">
                        <span className="text-gray-500">KB:</span>
                        {eventKbId === undefined ? (
                            <Loader2 className="size-3 animate-spin text-gray-400" />
                        ) : (
                            <select
                                value={eventKbId ?? globalKbId}
                                onChange={(e) => handleKbChange(e.target.value)}
                                className="text-xs border rounded px-1 py-0.5 bg-white focus:outline-none focus:ring-1 focus:ring-blue-500 max-w-[160px]"
                            >
                                {kbDocuments.map((doc) => (
                                    <option key={doc.id} value={doc.id}>
                                        {doc.title}{doc.id === globalKbId ? " (default)" : ""}
                                    </option>
                                ))}
                            </select>
                        )}
                    </div>
                )}
            </div>

            {/* Bot status badges + View Notes */}
            {event.bots.length > 0 && (
                <div className="mt-1 flex items-center gap-2 flex-wrap">
                    {(isRecordingScheduled) && (
                        <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-red-50 text-red-700">
                            <Video className="size-3" /> Recording
                        </span>
                    )}
                    {hasVoiceAgentBot && (
                        <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-purple-50 text-purple-700">
                            <Mic className="size-3" /> Voice Agent
                        </span>
                    )}
                    <button
                        onClick={() => navigate(`/dashboard/notes/${event.bots[0].bot_id}`)}
                        className="flex items-center gap-1 text-xs text-blue-600 hover:text-blue-800 hover:underline"
                    >
                        <FileText className="size-3" />
                        View Notes
                    </button>
                    <button
                        onClick={() => handleExportTranscript(event.bots[0].bot_id)}
                        disabled={isExporting}
                        className="flex items-center gap-1 text-xs text-blue-600 hover:text-blue-800 hover:underline disabled:opacity-50"
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
    );
}
