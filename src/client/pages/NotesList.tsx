import { useQuery } from "@tanstack/react-query";
import { Calendar, Download, FileText, Loader2, Users } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/Card";
import { Button } from "../components/ui/Button";

interface Meeting {
    bot_id: string;
    bot_type: string | null;
    meeting_url: string | null;
    done: boolean;
    created_at: string;
    title: string | null;
    participants: string[];
}

interface NotesResponse {
    meetings: Meeting[];
}

function NotesList() {
    const navigate = useNavigate();
    const [exportingBotId, setExportingBotId] = useState<string | null>(null);

    const { data, isPending } = useQuery<NotesResponse>({
        queryKey: ["notes"],
        queryFn: async () => {
            const res = await fetch("/api/notes");
            if (!res.ok) throw new Error(await res.text());
            return res.json();
        },
    });

    const meetings = data?.meetings ?? [];

    const handleExportTranscript = async (botId: string) => {
        setExportingBotId(botId);
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
            setExportingBotId(null);
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
                        <div className="divide-y">
                            {meetings.map((meeting) => (
                                <div
                                    key={meeting.bot_id}
                                    className="flex items-center justify-between py-3 gap-4"
                                >
                                    <div className="flex flex-col gap-1 min-w-0">
                                        <span className="text-sm font-medium text-gray-900 truncate">
                                            {meeting.title ?? "Untitled Meeting"}
                                        </span>
                                        <div className="flex items-center gap-3 text-xs text-gray-500">
                                            <span className="flex items-center gap-1">
                                                <Calendar className="size-3" />
                                                {formatDate(meeting.created_at)} at {formatTime(meeting.created_at)}
                                            </span>
                                            {meeting.participants.length > 0 && (
                                                <span className="flex items-center gap-1 truncate">
                                                    <Users className="size-3 shrink-0" />
                                                    {meeting.participants.join(", ")}
                                                </span>
                                            )}
                                        </div>
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
                                            onClick={() => handleExportTranscript(meeting.bot_id)}
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
                    )}
                </CardContent>
            </Card>
        </div>
    );
}

export default NotesList;
