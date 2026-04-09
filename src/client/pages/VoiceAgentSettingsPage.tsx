import { useState, useEffect, useRef } from "react";
import { Loader2, Bot, Camera, Upload, Trash2 } from "lucide-react";
import { toast } from "sonner";
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from "../components/ui/Card";

const VOICES = [
    { value: "marin", label: "Marin — Best (GA exclusive · most natural)" },
    { value: "marin", label: "Cedar — Best (GA exclusive · most natural)" },
    { value: "marin", label: "Coral — Good (warm and friendly)" },
    { value: "marin", label: "Ballad — Good (melodic and smooth)" },
    { value: "marin", label: "Ash — Good (clear and precise)" },
    { value: "marin", label: "Verse — Good (versatile and expressive)" },
    { value: "marin", label: "Sage — OK (calm and thoughtful)" },
    { value: "marin", label: "Alloy — OK (neutral and balanced)" },
    { value: "marin", label: "Shimmer — OK (bright and energetic)" },
    { value: "marin", label: "Echo — OK (resonant and deep)" },
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
    photo_url: string | null;
}

export default function VoiceAgentSettingsPage() {
    const [config, setConfig] = useState<Config | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [isSaving, setIsSaving] = useState(false);
    const [photoUrl, setPhotoUrl] = useState<string | null>(null);
    const [isUploadingPhoto, setIsUploadingPhoto] = useState(false);
    const fileInputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        fetch("/api/voice-agent-config")
            .then((r) => r.json())
            .then((data: Config) => {
                setConfig(data);
                setPhotoUrl(data.photo_url ?? null);
            })
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

    const handlePhotoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;

        const allowedTypes = ["image/png", "image/jpeg", "image/webp"];
        if (!allowedTypes.includes(file.type)) {
            toast.error("Please upload a PNG, JPEG, or WebP image.");
            return;
        }
        if (file.size > 2 * 1024 * 1024) {
            toast.error("Image must be smaller than 2MB.");
            return;
        }

        setIsUploadingPhoto(true);
        try {
            const reader = new FileReader();
            const base64 = await new Promise<string>((resolve, reject) => {
                reader.onload = () => {
                    const result = reader.result as string;
                    const base64Data = result.split(",")[1];
                    resolve(base64Data);
                };
                reader.onerror = reject;
                reader.readAsDataURL(file);
            });

            const res = await fetch("/api/voice-agent-config/photo", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    image: base64,
                    content_type: file.type,
                }),
            });

            if (!res.ok) throw new Error(await res.text());
            const data = await res.json();
            setPhotoUrl(data.photo_url);
            toast.success("Photo uploaded!");
        } catch (err) {
            console.error(err);
            toast.error("Failed to upload photo.");
        } finally {
            setIsUploadingPhoto(false);
            if (fileInputRef.current) fileInputRef.current.value = "";
        }
    };

    const handlePhotoDelete = async () => {
        try {
            const res = await fetch("/api/voice-agent-config/photo", { method: "DELETE" });
            if (!res.ok) throw new Error(await res.text());
            setPhotoUrl(null);
            toast.success("Photo removed.");
        } catch (err) {
            console.error(err);
            toast.error("Failed to remove photo.");
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
                        {/* Voice Agent Photo */}
                        <div className="space-y-3">
                            <p className="text-xs font-medium text-gray-400 uppercase tracking-wide">
                                Agent Photo
                            </p>
                            <p className="text-xs text-gray-500">
                                This photo is displayed as the voice agent's avatar during meetings.
                            </p>

                            <div className="flex items-center gap-4">
                                {/* Photo preview */}
                                <div className="relative">
                                    {photoUrl ? (
                                        <img
                                            src={photoUrl}
                                            alt="Voice Agent Avatar"
                                            className="size-20 rounded-full object-cover border-2 border-gray-200"
                                        />
                                    ) : (
                                        <div className="size-20 rounded-full bg-gray-100 border-2 border-dashed border-gray-300 flex items-center justify-center">
                                            <Camera className="size-6 text-gray-400" />
                                        </div>
                                    )}
                                </div>

                                {/* Upload / Remove buttons */}
                                <div className="flex flex-col gap-2">
                                    <input
                                        ref={fileInputRef}
                                        type="file"
                                        accept="image/png,image/jpeg,image/webp"
                                        onChange={handlePhotoUpload}
                                        className="hidden"
                                    />
                                    <button
                                        onClick={() => fileInputRef.current?.click()}
                                        disabled={isUploadingPhoto}
                                        className="px-3 py-1.5 text-sm rounded-md border border-gray-300 hover:bg-gray-50 disabled:opacity-50 flex items-center gap-2"
                                    >
                                        {isUploadingPhoto ? (
                                            <>
                                                <Loader2 className="size-4 animate-spin" />
                                                Uploading…
                                            </>
                                        ) : (
                                            <>
                                                <Upload className="size-4" />
                                                {photoUrl ? "Change Photo" : "Upload Photo"}
                                            </>
                                        )}
                                    </button>
                                    {photoUrl && (
                                        <button
                                            onClick={handlePhotoDelete}
                                            className="px-3 py-1.5 text-sm rounded-md text-red-600 hover:bg-red-50 flex items-center gap-2"
                                        >
                                            <Trash2 className="size-4" />
                                            Remove
                                        </button>
                                    )}
                                </div>
                            </div>
                        </div>

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
