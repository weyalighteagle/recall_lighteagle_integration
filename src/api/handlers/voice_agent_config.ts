import { supabase } from "../config/supabase";

export interface VoiceAgentConfig {
    id?: string;
    name: string;
    system_prompt: string;
    voice: string;
    language: string;
    is_active: boolean;
    wake_word: string | null;
    photo_url: string | null;
}

/**
 * Get the active voice agent config (singleton — one active row).
 */
export async function voice_agent_config_get(): Promise<VoiceAgentConfig> {
    const { data, error } = await supabase
        .from("voice_agent_config")
        .select("id, name, system_prompt, voice, language, is_active, wake_word, photo_url")
        .eq("is_active", true)
        .limit(1)
        .maybeSingle();

    if (error) throw new Error(error.message);
    if (!data) throw new Error("No active voice agent config found");

    return data as VoiceAgentConfig;
}

/**
 * Update the active voice agent config row.
 * Only system_prompt, voice, language, and wake_word are patchable.
 */
export async function voice_agent_config_update(
    patch: Partial<Pick<VoiceAgentConfig, "system_prompt" | "voice" | "language" | "wake_word" | "photo_url">>
): Promise<VoiceAgentConfig> {
    const { data: existing, error: fetchError } = await supabase
        .from("voice_agent_config")
        .select("id, name, system_prompt, voice, language, is_active, wake_word, photo_url")
        .eq("is_active", true)
        .limit(1)
        .maybeSingle();

    if (fetchError) throw new Error(fetchError.message);
    if (!existing) throw new Error("No active voice agent config found");

    const merged = {
        system_prompt: patch.system_prompt ?? existing.system_prompt,
        voice: patch.voice ?? existing.voice,
        language: patch.language ?? existing.language,
        // Preserve explicit null (clears wake word) vs undefined (keep existing)
        wake_word: patch.wake_word !== undefined
            ? (patch.wake_word?.trim() || null)
            : (existing.wake_word ?? null),
        photo_url: patch.photo_url !== undefined
            ? (patch.photo_url?.trim() || null)
            : (existing.photo_url ?? null),
        updated_at: new Date().toISOString(),
    };

    const { error: updateError } = await supabase
        .from("voice_agent_config")
        .update(merged)
        .eq("id", existing.id);

    if (updateError) throw new Error(updateError.message);

    return { ...existing, ...merged } as VoiceAgentConfig;
}