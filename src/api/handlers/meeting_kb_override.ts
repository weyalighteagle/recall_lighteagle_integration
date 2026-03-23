import { supabase } from "../config/supabase";

/** GET /api/meeting-kb/:calendarEventId — returns override or null */
export async function meeting_kb_get(calendar_event_id: string): Promise<{ kb_document_id: string | null }> {
    const { data, error } = await supabase
        .from("meeting_kb_overrides")
        .select("kb_document_id")
        .eq("calendar_event_id", calendar_event_id)
        .maybeSingle();
    if (error) throw new Error(error.message);
    return { kb_document_id: data?.kb_document_id ?? null };
}

/** PUT /api/meeting-kb/:calendarEventId — upserts override */
export async function meeting_kb_upsert(calendar_event_id: string, kb_document_id: string): Promise<void> {
    const { error } = await supabase
        .from("meeting_kb_overrides")
        .upsert(
            { calendar_event_id, kb_document_id, updated_at: new Date().toISOString() },
            { onConflict: "calendar_event_id" },
        );
    if (error) throw new Error(error.message);
}

/** DELETE /api/meeting-kb/:calendarEventId — removes override, falls back to global default */
export async function meeting_kb_delete(calendar_event_id: string): Promise<void> {
    const { error } = await supabase
        .from("meeting_kb_overrides")
        .delete()
        .eq("calendar_event_id", calendar_event_id);
    if (error) throw new Error(error.message);
}
