import { useState, useEffect } from "react";
import { Loader2, Bot } from "lucide-react";
import { toast } from "sonner";
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from "../components/ui/Card";

const VOICES = [
    { value: "marin",   label: "Marin — Best (GA exclusive · most natural)" },
    { value: "cedar",   label: "Cedar — Best (GA exclusive · most natural)" },
    { value: "coral",   label: "Coral — Good (warm and friendly)" },
    { value: "ballad",  label: "Ballad — Good (melodic and smooth)" },
    { value: "ash",     label: "Ash — Good (clear and precise)" },
    { value: "verse",   label: "Verse — Good (versatile and expressive)" },
    { value: "sage",    label: "Sage — OK (calm and thoughtful)" },
    { value: "alloy",   label: "Alloy — OK (neutral and balanced)" },
    { value: "shimmer", label: "Shimmer — OK (bright and energetic)" },
    { value: "echo",    label: "Echo — OK (resonant and deep)" },
];

const LANGUAGES = [
    { value: "tr", label: "Türkçe" },
    { value: "en", label: "English" },
];

interface Config {
    name: string;
    system_prompt: string;
    voice: string;
    language: string;
    wake_word: string | null;
}

export default function VoiceAgentSettingsPage() {
    const [config, setConfig] = useState<Config | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [isSaving, setIsSaving] = useState(false);

    useEffect(() => {
        fetch("/api/voice-agent-config")
            .then((r) => r.json())
            .then((data: Config) => setConfig(data))
            .catch(() => toast.error("Failed to load voice agent config"))
            .finally(() => setIsLoading(false));
    }, []);

    const handleSave = async () => {
        if (!config) return;
        setIsSaving(true);
        try {
            const res = await fetch("/api/voice-agent-config", {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    system_prompt: config.system_prompt,
                    voice: config.voice,
                    language: config.language,
                    wake_word: config.wake_word?.trim() || null,
                }),
            });
            if (!res.ok) throw new Error(await res.text());
            toast.success("Voice agent configuration saved");
        } catch (err) {
            console.error(err);
            toast.error("Failed to save configuration");
        } finally {
            setIsSaving(false);
        }
    };

    return (
        <div className="flex flex-col gap-4 max-w-3xl mx-auto">
            <div className="flex items-center justify-between">
                <h1 className="text-lg font-semibold flex items-center gap-2">
                    <Bot className="size-5 text-blue-600" />
                    Voice Agent Settings
                </h1>
            </div>

            {isLoading ? (
                <div className="flex items-center gap-2 text-sm text-gray-500 py-8">
                    <Loader2 className="size-4 animate-spin" />
                    Loading configuration…
                </div>
            ) : !config ? (
                <p className="text-sm text-red-500">Could not load configuration.</p>
            ) : (
                <Card>
                    <CardHeader className="pb-3">
                        <CardTitle className="text-base">{config.name}</CardTitle>
                        <CardDescription>
                            Configure the system prompt and voice settings for the Voice Agent bot.
                            Changes apply to all future meetings.
                        </CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-5">
                        {/* Voice + Language row */}
                        <div className="flex gap-4">
                            <div className="flex-1 space-y-1.5">
                                <label className="text-xs font-medium text-gray-400 uppercase tracking-wide">
                                    Voice
                                </label>
                                <select
                                    value={config.voice}
                                    onChange={(e) => setConfig({ ...config, voice: e.target.value })}
                                    className="w-full px-3 py-2 border rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
                                >
                                    {VOICES.map((v) => (
                                        <option key={v.value} value={v.value}>
                                            {v.label}
                                        </option>
                                    ))}
                                </select>
                            </div>
                            <div className="flex-1 space-y-1.5">
                                <label className="text-xs font-medium text-gray-400 uppercase tracking-wide">
                                    Language
                                </label>
                                <select
                                    value={config.language}
                                    onChange={(e) => setConfig({ ...config, language: e.target.value })}
                                    className="w-full px-3 py-2 border rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
                                >
                                    {LANGUAGES.map((l) => (
                                        <option key={l.value} value={l.value}>
                                            {l.label}
                                        </option>
                                    ))}
                                </select>
                            </div>
                        </div>

                        {/* Wake Word */}
                        <div className="space-y-1.5">
                            <label className="text-xs font-medium text-gray-400 uppercase tracking-wide">
                                Wake Word
                            </label>
                            <input
                                type="text"
                                value={config.wake_word ?? ""}
                                onChange={(e) => setConfig({ ...config, wake_word: e.target.value })}
                                placeholder="e.g. weya"
                                className="w-full px-3 py-2 border rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                            />
                            <p className="text-xs text-gray-400">
                                When set, the assistant will only respond after hearing this word. Leave empty to disable.
                            </p>
                        </div>

                        {/* System Prompt */}
                        <div className="space-y-1.5">
                            <label className="text-xs font-medium text-gray-400 uppercase tracking-wide">
                                System Prompt
                            </label>
                            <textarea
                                value={config.system_prompt}
                                onChange={(e) => setConfig({ ...config, system_prompt: e.target.value })}
                                rows={14}
                                className="w-full px-3 py-2 border rounded-md text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500 resize-y"
                            />
                        </div>

                        {/* Save */}
                        <div className="flex justify-end">
                            <button
                                onClick={handleSave}
                                disabled={isSaving}
                                className="px-5 py-2 text-sm rounded-md bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 flex items-center gap-2 transition-colors"
                            >
                                {isSaving ? (
                                    <>
                                        <Loader2 className="size-4 animate-spin" />
                                        Saving…
                                    </>
                                ) : (
                                    "Save Changes"
                                )}
                            </button>
                        </div>
                    </CardContent>
                </Card>
            )}
        </div>
    );
}
