import { useParams, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Bot, Calendar, Download, FileText, Loader2, MessageSquare, User, Users } from "lucide-react";
import { Button } from "../components/ui/Button";
import {
    Card,
    CardContent,
    CardHeader,
    CardTitle,
} from "../components/ui/Card";
import { ScrollArea } from "../components/ui/ScrollArea";

interface Utterance {
    participant: string;
    words: { text: string; start_timestamp?: number; end_timestamp?: number }[];
    timestamp: string;
}

interface NoteDetailResponse {
    utterances: Utterance[];
    done: boolean;
    title: string | null;
    participants: string[];
}

function TranscriptView() {
    const { botId } = useParams<{ botId: string }>();
    const navigate = useNavigate();

    const { data, isPending, isError } = useQuery<NoteDetailResponse>({
        queryKey: ["note-detail", botId],
        queryFn: async () => {
            const res = await fetch(`/api/notes/${botId}`);
            if (!res.ok) throw new Error(await res.text());
            return res.json();
        },
        enabled: !!botId,
        refetchInterval: 5000, // Poll every 5s for live updates
    });

    const utterances = data?.utterances ?? [];
    const isDone = data?.done ?? false;
    const title = data?.title ?? "Untitled Meeting";
    const participants = data?.participants ?? [];

    const handleExportTranscript = () => {
        if (utterances.length === 0) return;
        const lines = utterances.map((u) => {
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
    };

    return (
        <div className="flex flex-col gap-4 max-w-3xl mx-auto">
            {/* Header */}
            <div className="flex items-center gap-3">
                <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => navigate("/dashboard/notes")}
                    className="flex items-center gap-1"
                >
                    <ArrowLeft className="size-4" />
                    Back to Notes
                </Button>
                {utterances.length > 0 && (
                    <Button
                        variant="outline"
                        size="sm"
                        onClick={handleExportTranscript}
                        className="flex items-center gap-1 ml-auto"
                    >
                        <Download className="size-4" />
                        Export Transcript
                    </Button>
                )}
            </div>

            <Card>
                <CardHeader className="pb-3">
                    <CardTitle className="text-base flex items-center gap-2">
                        <FileText className="size-4" />
                        {title}
                    </CardTitle>
                    <div className="flex flex-wrap items-center gap-3 text-sm text-gray-500">
                        {participants.length > 0 && (
                            <span className="flex items-center gap-1">
                                <Users className="size-3.5" />
                                {participants.join(", ")}
                            </span>
                        )}
                        {isDone && (
                            <span className="text-green-600 font-medium flex items-center gap-1">
                                <Calendar className="size-3.5" />
                                Transcript complete
                            </span>
                        )}
                        {!isDone && utterances.length > 0 && (
                            <span className="text-blue-600 font-medium">
                                Live (updating every 5s)
                            </span>
                        )}
                    </div>
                </CardHeader>
                <CardContent>
                    {isPending ? (
                        <div className="flex flex-col items-center justify-center py-12">
                            <Loader2 className="size-8 text-blue-500 mb-3 animate-spin" />
                            <p className="text-sm font-medium text-gray-700">
                                Loading transcript...
                            </p>
                        </div>
                    ) : isError ? (
                        <div className="flex flex-col items-center justify-center py-12">
                            <p className="text-sm text-red-500">
                                Failed to load transcript. Please try again.
                            </p>
                        </div>
                    ) : utterances.length === 0 ? (
                        <div className="flex flex-col items-center justify-center py-12">
                            <MessageSquare className="size-8 text-gray-300 mb-2" />
                            <p className="text-sm text-gray-500">
                                No transcript available yet
                            </p>
                            <p className="text-xs text-gray-400 mt-1">
                                Transcript will appear here once the bot joins the meeting
                            </p>
                        </div>
                    ) : (
                        <ScrollArea className="h-[500px]">
                            <div className="space-y-3 pr-4">
                                {utterances.map((utterance, index) => {
                                    const isWeya = utterance.participant.toUpperCase().includes("WEYA");
                                    return (
                                    <div
                                        key={index}
                                        className="flex gap-3 p-3 rounded-lg bg-gray-50 hover:bg-gray-100 transition-colors"
                                    >
                                        <div className={`flex items-center justify-center size-8 rounded-full shrink-0 mt-0.5 ${isWeya ? "bg-violet-100" : "bg-blue-100"}`}>
                                            {isWeya
                                                ? <Bot className="size-4 text-violet-600" />
                                                : <User className="size-4 text-blue-600" />
                                            }
                                        </div>
                                        <div className="flex-1 min-w-0">
                                            <div className="flex items-center gap-2 mb-1">
                                                <span className="text-sm font-medium text-gray-900">
                                                    {utterance.participant}
                                                </span>
                                                {isWeya && (
                                                    <span className="text-xs font-medium text-violet-600 bg-violet-100 px-1.5 py-0.5 rounded">
                                                        AI
                                                    </span>
                                                )}
                                                <span className="text-xs text-gray-400">
                                                    {new Date(utterance.timestamp).toLocaleTimeString([], {
                                                        hour: "2-digit",
                                                        minute: "2-digit",
                                                        second: "2-digit",
                                                    })}
                                                </span>
                                            </div>
                                            <p className="text-sm text-gray-700">
                                                {utterance.words
                                                    .map((w) => w.text)
                                                    .join(" ")}
                                            </p>
                                        </div>
                                    </div>
                                    );
                                })}
                            </div>
                        </ScrollArea>
                    )}
                </CardContent>
            </Card>
        </div>
    );
}

export default TranscriptView;
