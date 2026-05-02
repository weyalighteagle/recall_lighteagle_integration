import { useAuth } from "@clerk/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Calendar, ChevronLeft, ChevronRight, Download, FileText, Loader2, Pencil, Users } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/Card";
import { Button } from "../components/ui/Button";

const ITEMS_PER_PAGE = 10;

interface Tag {
    id: string;
    name: string;
    slug: string;
    color: string | null;
}

interface Meeting {
    bot_id: string;
    bot_type: string | null;
    meeting_url: string | null;
    done: boolean;
    created_at: string;
    meeting_start_time?: string | null;
    title: string | null;
    participants: string[];
}

interface NotesResponse {
    meetings: Meeting[];
}

interface MeetingTagPickerProps {
    botId: string;
    getToken: () => Promise<string | null>;
}

function MeetingTagPicker({ botId, getToken }: MeetingTagPickerProps) {
    const queryClient = useQueryClient();
    const [showPicker, setShowPicker] = useState(false);
    const [saving, setSaving] = useState(false);
    const pickerRef = useRef<HTMLDivElement>(null);

    const { data: meetingTagsData } = useQuery<{ tags: Tag[] }>({
        queryKey: ["meeting_tags", botId],
        queryFn: async () => {
            const token = await getToken();
            const res = await fetch(`/api/meetings/${botId}/tags`, {
                headers: { Authorization: `Bearer ${token}` },
            });
            if (!res.ok) throw new Error(await res.text());
            return res.json();
        },
        staleTime: 30_000,
    });
    const meetingTags = meetingTagsData?.tags ?? [];

    const { data: allTagsData } = useQuery<{ tags: Tag[] }>({
        queryKey: ["kb_tags"],
        queryFn: async () => {
            const token = await getToken();
            const res = await fetch("/api/kb/tags", {
                headers: { Authorization: `Bearer ${token}` },
            });
            if (!res.ok) throw new Error(await res.text());
            return res.json();
        },
    });
    const allTags = allTagsData?.tags ?? [];

    useEffect(() => {
        if (!showPicker) return;
        const handler = (e: MouseEvent) => {
            if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
                setShowPicker(false);
            }
        };
        document.addEventListener("mousedown", handler);
        return () => document.removeEventListener("mousedown", handler);
    }, [showPicker]);

    const toggleTag = async (tag: Tag) => {
        const hasTag = meetingTags.some((t) => t.id === tag.id);
        const newTags = hasTag ? meetingTags.filter((t) => t.id !== tag.id) : [...meetingTags, tag];
        const oldData = queryClient.getQueryData<{ tags: Tag[] }>(["meeting_tags", botId]);
        queryClient.setQueryData(["meeting_tags", botId], { tags: newTags });
        setSaving(true);
        try {
            const token = await getToken();
            const res = await fetch(`/api/meetings/${botId}/tags`, {
                method: "PUT",
                headers: {
                    Authorization: `Bearer ${token}`,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({ tag_ids: newTags.map((t) => t.id) }),
            });
            if (!res.ok) {
                queryClient.setQueryData(["meeting_tags", botId], oldData);
                toast.error("Couldn't update tags");
            } else {
                queryClient.invalidateQueries({ queryKey: ["meeting_tags", botId] });
            }
        } catch {
            queryClient.setQueryData(["meeting_tags", botId], oldData);
            toast.error("Couldn't update tags");
        } finally {
            setSaving(false);
        }
    };

    return (
        <div className="relative flex items-center gap-1 flex-wrap mt-1" ref={pickerRef}>
            {meetingTags.map((tag) => (
                <span
                    key={tag.id}
                    className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-700"
                >
                    {tag.color && (
                        <span className="size-2 rounded-full shrink-0" style={{ backgroundColor: tag.color }} />
                    )}
                    {tag.name}
                    <button
                        type="button"
                        className="text-gray-400 hover:text-gray-600 leading-none ml-0.5"
                        onClick={(e) => { e.stopPropagation(); toggleTag(tag); }}
                        disabled={saving}
                    >
                        ×
                    </button>
                </span>
            ))}
            <button
                type="button"
                className="text-xs text-gray-400 hover:text-gray-600"
                onClick={() => setShowPicker(true)}
                disabled={saving}
            >
                + category
            </button>
            {showPicker && (
                <div className="absolute top-full left-0 mt-1 z-10 bg-white border border-gray-200 rounded-lg shadow-lg p-1.5 min-w-[180px]">
                    {allTags.length === 0 ? (
                        <p className="text-xs text-gray-400 px-2 py-1">No tags yet</p>
                    ) : (
                        allTags.map((tag) => {
                            const active = meetingTags.some((t) => t.id === tag.id);
                            return (
                                <button
                                    key={tag.id}
                                    type="button"
                                    className={`flex items-center gap-2 w-full text-left px-2 py-1.5 rounded hover:bg-gray-50 text-sm ${active ? "font-medium" : ""}`}
                                    onClick={() => toggleTag(tag)}
                                    disabled={saving}
                                >
                                    {tag.color && (
                                        <span className="size-3 rounded-full shrink-0" style={{ backgroundColor: tag.color }} />
                                    )}
                                    <span className="truncate">{tag.name}</span>
                                    {active && <span className="ml-auto text-blue-500 text-xs">✓</span>}
                                </button>
                            );
                        })
                    )}
                </div>
            )}
        </div>
    );
}

function NotesList() {
    const navigate = useNavigate();
    const { getToken } = useAuth();
    const queryClient = useQueryClient();
    const [exportingBotId, setExportingBotId] = useState<string | null>(null);
    const [currentPage, setCurrentPage] = useState(1);
    const [editingBotId, setEditingBotId] = useState<string | null>(null);
    const [editValue, setEditValue] = useState("");
    const [editError, setEditError] = useState<string | null>(null);
    const [savingBotId, setSavingBotId] = useState<string | null>(null);
    // Prevents the blur handler from firing a save after Enter or Escape already handled it.
    const skipNextBlurRef = useRef(false);

    const { data, isPending } = useQuery<NotesResponse>({
        queryKey: ["notes"],
        queryFn: async () => {
            const token = await getToken();
            const res = await fetch("/api/notes", {
                headers: { Authorization: `Bearer ${token}` },
            });
            if (!res.ok) throw new Error(await res.text());
            return res.json();
        },
    });

    const allMeetings = data?.meetings ?? [];
    const totalPages = Math.max(1, Math.ceil(allMeetings.length / ITEMS_PER_PAGE));
    const meetings = allMeetings.slice(
        (currentPage - 1) * ITEMS_PER_PAGE,
        currentPage * ITEMS_PER_PAGE,
    );

    const sanitizeFilename = (name: string) =>
        name.replace(/[^a-zA-Z0-9À-ɏЀ-ӿ\s\-_]/g, "").trim().replace(/\s+/g, "-");

    const handleExportTranscript = async (botId: string, meetingTitle: string | null) => {
        setExportingBotId(botId);
        try {
            const token = await getToken();
            const res = await fetch(`/api/notes/${botId}`, {
                headers: { Authorization: `Bearer ${token}` },
            });
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
            const filename = meetingTitle
                ? `${sanitizeFilename(meetingTitle)}.txt`
                : `transcript-${botId}.txt`;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        } catch (err) {
            console.error("Failed to export transcript:", err);
        } finally {
            setExportingBotId(null);
        }
    };

    const startEdit = (meeting: Meeting) => {
        setEditingBotId(meeting.bot_id);
        setEditValue(meeting.title ?? "");
        setEditError(null);
    };

    const cancelEdit = () => {
        skipNextBlurRef.current = true;
        setEditingBotId(null);
        setEditError(null);
    };

    const saveTitleEdit = async (botId: string, oldTitle: string | null) => {
        const trimmed = editValue.trim();
        if (!trimmed) {
            setEditError("Title cannot be empty");
            return; // keep edit mode open
        }

        // Signal the blur handler (which fires as the input unmounts) to skip.
        skipNextBlurRef.current = true;
        setEditingBotId(null);
        setEditError(null);

        if (trimmed === (oldTitle ?? "")) return; // unchanged — no API call needed

        // Optimistic update
        queryClient.setQueryData<NotesResponse>(["notes"], (old) => {
            if (!old) return old;
            return {
                meetings: old.meetings.map((m) =>
                    m.bot_id === botId ? { ...m, title: trimmed } : m,
                ),
            };
        });

        setSavingBotId(botId);
        try {
            const token = await getToken();
            const res = await fetch(`/api/notes/${botId}`, {
                method: "PATCH",
                headers: {
                    Authorization: `Bearer ${token}`,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({ title: trimmed }),
            });
            if (!res.ok) throw new Error(await res.text());
            const { title: savedTitle }: { title: string } = await res.json();

            // Reconcile with server-returned title
            queryClient.setQueryData<NotesResponse>(["notes"], (old) => {
                if (!old) return old;
                return {
                    meetings: old.meetings.map((m) =>
                        m.bot_id === botId ? { ...m, title: savedTitle } : m,
                    ),
                };
            });
        } catch {
            // Revert optimistic update and notify
            queryClient.setQueryData<NotesResponse>(["notes"], (old) => {
                if (!old) return old;
                return {
                    meetings: old.meetings.map((m) =>
                        m.bot_id === botId ? { ...m, title: oldTitle } : m,
                    ),
                };
            });
            toast.error("Couldn't rename meeting");
        } finally {
            setSavingBotId(null);
        }
    };

    const formatDate = (dateStr: string) =>
        new Date(dateStr).toLocaleDateString([], {
            year: "numeric",
            month: "short",
            day: "numeric",
        });

    const formatTime = (dateStr: string) =>
        new Date(dateStr).toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
        });

    return (
        <div className="flex flex-col gap-4 max-w-3xl mx-auto">
            <Card>
                <CardHeader className="pb-3">
                    <CardTitle className="text-base flex items-center gap-2">
                        <FileText className="size-4" />
                        All Meeting Notes
                    </CardTitle>
                </CardHeader>
                <CardContent>
                    {isPending ? (
                        <div className="flex flex-col items-center justify-center py-12">
                            <Loader2 className="size-8 text-blue-500 mb-3 animate-spin" />
                            <p className="text-sm text-gray-500">Loading meetings…</p>
                        </div>
                    ) : meetings.length === 0 ? (
                        <div className="flex flex-col items-center justify-center py-12">
                            <FileText className="size-8 text-gray-300 mb-2" />
                            <p className="text-sm text-gray-500">No meetings recorded yet</p>
                        </div>
                    ) : (
                        <>
                        <div className="divide-y">
                            {meetings.map((meeting) => (
                                <div
                                    key={meeting.bot_id}
                                    className="flex items-center justify-between py-3 gap-4"
                                >
                                    <div className="flex flex-col gap-1 min-w-0">
                                        {editingBotId === meeting.bot_id ? (
                                            <div className="flex flex-col gap-0.5">
                                                <input
                                                    className="text-sm font-medium text-gray-900 border border-blue-400 rounded px-1.5 py-0.5 outline-none focus:ring-2 focus:ring-blue-200 w-full"
                                                    value={editValue}
                                                    maxLength={200}
                                                    autoFocus
                                                    onFocus={(e) => e.target.select()}
                                                    onChange={(e) => {
                                                        setEditValue(e.target.value);
                                                        setEditError(null);
                                                    }}
                                                    onKeyDown={(e) => {
                                                        if (e.key === "Enter") saveTitleEdit(meeting.bot_id, meeting.title);
                                                        if (e.key === "Escape") cancelEdit();
                                                    }}
                                                    onBlur={() => {
                                                        if (skipNextBlurRef.current) {
                                                            skipNextBlurRef.current = false;
                                                            return;
                                                        }
                                                        saveTitleEdit(meeting.bot_id, meeting.title);
                                                    }}
                                                />
                                                {editError && (
                                                    <span className="text-xs text-red-500">{editError}</span>
                                                )}
                                            </div>
                                        ) : (
                                            <button
                                                type="button"
                                                className="group flex items-center gap-1 text-left w-full"
                                                onClick={() => startEdit(meeting)}
                                                disabled={savingBotId === meeting.bot_id}
                                            >
                                                <span className={`text-sm font-medium truncate ${savingBotId === meeting.bot_id ? "text-gray-400" : "text-gray-900"}`}>
                                                    {meeting.title ?? "Untitled Meeting"}
                                                </span>
                                                {savingBotId === meeting.bot_id ? (
                                                    <Loader2 className="size-3 text-gray-400 animate-spin shrink-0" />
                                                ) : (
                                                    <Pencil className="size-3 text-gray-400 opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
                                                )}
                                            </button>
                                        )}
                                        <div className="flex items-center gap-3 text-xs text-gray-500">
                                            <span className="flex items-center gap-1">
                                                <Calendar className="size-3" />
                                                {formatDate(meeting.meeting_start_time ?? meeting.created_at)} at {formatTime(meeting.meeting_start_time ?? meeting.created_at)}
                                            </span>
                                            {meeting.participants.length > 0 && (
                                                <span className="flex items-center gap-1 truncate">
                                                    <Users className="size-3 shrink-0" />
                                                    {meeting.participants.join(", ")}
                                                </span>
                                            )}
                                        </div>
                                        <MeetingTagPicker botId={meeting.bot_id} getToken={getToken} />
                                    </div>
                                    <div className="flex items-center gap-2 shrink-0">
                                        <span
                                            className={`text-xs font-medium px-2 py-0.5 rounded-full ${
                                                meeting.done
                                                    ? "bg-green-100 text-green-700"
                                                    : "bg-gray-100 text-gray-500"
                                            }`}
                                        >
                                            {meeting.done ? "Complete" : "Processing"}
                                        </span>
                                        <Button
                                            size="sm"
                                            variant="outline"
                                            disabled={exportingBotId === meeting.bot_id}
                                            onClick={() => handleExportTranscript(meeting.bot_id, meeting.title)}
                                        >
                                            {exportingBotId === meeting.bot_id ? (
                                                <Loader2 className="size-4 animate-spin mr-1" />
                                            ) : (
                                                <Download className="size-4 mr-1" />
                                            )}
                                            Export
                                        </Button>
                                        <Button
                                            size="sm"
                                            variant="outline"
                                            onClick={() =>
                                                navigate(`/dashboard/notes/${meeting.bot_id}`)
                                            }
                                        >
                                            View Transcript
                                        </Button>
                                    </div>
                                </div>
                            ))}
                        </div>
                        {totalPages > 1 && (
                            <div className="flex items-center justify-between pt-4 border-t mt-2">
                                <span className="text-xs text-gray-500">
                                    Page {currentPage} of {totalPages} ({allMeetings.length} meetings)
                                </span>
                                <div className="flex items-center gap-2">
                                    <Button
                                        size="sm"
                                        variant="outline"
                                        disabled={currentPage === 1}
                                        onClick={() => setCurrentPage((p) => p - 1)}
                                    >
                                        <ChevronLeft className="size-4" />
                                        Previous
                                    </Button>
                                    <Button
                                        size="sm"
                                        variant="outline"
                                        disabled={currentPage === totalPages}
                                        onClick={() => setCurrentPage((p) => p + 1)}
                                    >
                                        Next
                                        <ChevronRight className="size-4" />
                                    </Button>
                                </div>
                            </div>
                        )}
                        </>
                    )}
                </CardContent>
            </Card>
        </div>
    );
}

export default NotesList;
