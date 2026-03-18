import { Bot, ChevronRight } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { Card, CardContent } from "../components/ui/Card";

export default function SettingsPage() {
    const navigate = useNavigate();

    return (
        <div className="flex flex-col gap-4 max-w-3xl mx-auto">
            <h1 className="text-lg font-semibold">Settings</h1>

            <Card
                className="cursor-pointer hover:shadow-md transition-shadow"
                onClick={() => navigate("/dashboard/voice-agent-settings")}
            >
                <CardContent className="flex items-center gap-4 py-4">
                    <div className="flex items-center justify-center size-10 rounded-lg bg-blue-50">
                        <Bot className="size-5 text-blue-600" />
                    </div>
                    <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-gray-900">Voice Agent Settings</p>
                        <p className="text-xs text-gray-500 mt-0.5">
                            Edit system prompt, voice, and language for the Voice Agent bot
                        </p>
                    </div>
                    <ChevronRight className="size-4 text-gray-400 shrink-0" />
                </CardContent>
            </Card>
        </div>
    );
}
