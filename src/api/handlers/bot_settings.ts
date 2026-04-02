import { supabase } from "../config/supabase";

export type BotMode = "transcriptor" | "voice_agent";

export interface BotSettings {
    bot_mode: BotMode;
    active_kb_id: string | null;
    auto_join_enabled: boolean;
}

const DEFAULTS: BotSettings = {
    bot_mode: "transcriptor",
    active_kb_id: "d811bc5d-3644-4adf-9ab6-4797803e1b8e",
    auto_join_enabled: true,
};

/**
 * Get the current global bot settings (singleton row).
 * Returns defaults when the table is empty.
 */
export async function bot_settings_get(): Promise<BotSettings> {
    const { data } = await supabase
        .from("bot_settings")
        .select("bot_mode, active_kb_id, auto_join_enabled")
        .limit(1)
        .maybeSingle();

    if (!data) return { ...DEFAULTS };
    return {
        bot_mode: (data.bot_mode as BotMode) ?? DEFAULTS.bot_mode,
        active_kb_id: data.active_kb_id ?? null,
        auto_join_enabled: data.auto_join_enabled ?? DEFAULTS.auto_join_enabled,
    };
}

/**
 * Update the singleton bot_settings row.
 * Creates the row if it doesn't exist yet.
 */
export async function bot_settings_update(patch: Partial<BotSettings>): Promise<BotSettings> {
    const { data: existing } = await supabase
        .from("bot_settings")
        .select("id, bot_mode, active_kb_id")
        .limit(1)
        .maybeSingle();

    const merged: BotSettings = {
        bot_mode: patch.bot_mode ?? (existing?.bot_mode as BotMode) ?? DEFAULTS.bot_mode,
        active_kb_id: patch.active_kb_id !== undefined
            ? patch.active_kb_id
            : (existing?.active_kb_id ?? null),
        auto_join_enabled: patch.auto_join_enabled !== undefined
            ? patch.auto_join_enabled
            : (existing?.auto_join_enabled ?? DEFAULTS.auto_join_enabled),
    };

    if (existing) {
        const { error } = await supabase
            .from("bot_settings")
            .update({ ...merged, updated_at: new Date().toISOString() })
            .eq("id", existing.id);
        if (error) throw new Error(error.message);
    } else {
        const { error } = await supabase
            .from("bot_settings")
            .insert(merged);
        if (error) throw new Error(error.message);
    }

    return merged;
}
