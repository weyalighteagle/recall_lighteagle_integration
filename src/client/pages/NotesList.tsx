import { useQuery } from "@tanstack/react-query";
import { FileText, Loader2 } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/Card";
import { Button } from "../components/ui/Button";

interface Meeting {
    bot_id: string;
    done: boolean;
    created_at: string;
}

interface MeetingsResponse {
    meetings: Meeting[];
}

function NotesList() {
    const navigate = useNavigate();

    const { data, isPending } = useQuery<MeetingsResponse>({
        queryKey: ["meetings"],
        queryFn: async () => {
            const res = await fetch("/api/transcripts");
            if (!res.ok) throw new Error(await res.text());
            return res.json();
        },
    });

    const meetings = data?.meetings ?? [];

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
                                    className="flex items-center justify-between py-3"
                                >
                                    <div className="flex flex-col gap-0.5">
                                        <span className="text-sm font-medium text-gray-800">
                                            {new Date(meeting.created_at).toLocaleString([], {
                                                year: "numeric",
                                                month: "short",
                                                day: "numeric",
                                                hour: "2-digit",
                                                minute: "2-digit",
                                            })}
                                        </span>
                                        <span className="text-xs text-gray-400 font-mono">
                                            {meeting.bot_id}
                                        </span>
                                    </div>
                                    <div className="flex items-center gap-3">
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
