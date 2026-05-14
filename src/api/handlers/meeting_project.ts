import { supabase } from "../config/supabase";

/** PUT /api/meeting-project — assign a meeting to a project (upsert) */
export async function meeting_project_upsert(
    body: Record<string, unknown>,
    userId: string,
): Promise<{ message: string }> {
    const { project_id, calendar_event_id, bot_id } = body as {
        project_id?: string;
        calendar_event_id?: string;
        bot_id?: string;
    };

    if (!project_id) throw new Error("project_id is required");
    if (calendar_event_id && bot_id) throw new Error("Provide either calendar_event_id or bot_id, not both");
    if (!calendar_event_id && !bot_id) throw new Error("Either calendar_event_id or bot_id is required");

    const { data: project, error: projectErr } = await supabase
        .from("kb_projects")
        .select("id")
        .eq("id", project_id)
        .eq("user_id", userId)
        .maybeSingle();

    if (projectErr) throw new Error(projectErr.message);
    if (!project) {
        const e = new Error("Project not found");
        (e as any).statusCode = 404; // eslint-disable-line @typescript-eslint/no-explicit-any
        throw e;
    }

    const conflictCol = calendar_event_id ? "calendar_event_id" : "bot_id";

    const { error } = await supabase
        .from("meeting_projects")
        .upsert(
            { project_id, calendar_event_id: calendar_event_id ?? null, bot_id: bot_id ?? null },
            { onConflict: conflictCol },
        );

    if (error) throw new Error(error.message);
    return { message: "Assignment saved" };
}

/** GET /api/meeting-project?calendar_event_id=... OR ?bot_id=... */
export async function meeting_project_get(
    params: { calendar_event_id?: string; bot_id?: string },
    userId: string,
): Promise<{ project_id: string | null }> {
    const { calendar_event_id, bot_id } = params;

    if (!calendar_event_id && !bot_id) return { project_id: null };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let query: any = supabase
        .from("meeting_projects")
        .select("project_id, kb_projects!inner(user_id)")
        .eq("kb_projects.user_id", userId);

    query = calendar_event_id
        ? query.eq("calendar_event_id", calendar_event_id)
        : query.eq("bot_id", bot_id);

    const { data, error } = await query.maybeSingle();
    if (error) throw new Error(error.message);
    return { project_id: (data as any)?.project_id ?? null }; // eslint-disable-line @typescript-eslint/no-explicit-any
}

/** DELETE /api/meeting-project?calendar_event_id=... OR ?bot_id=... — silent no-op if not found */
export async function meeting_project_delete(
    params: { calendar_event_id?: string; bot_id?: string },
    userId: string,
): Promise<{ message: string }> {
    const { calendar_event_id, bot_id } = params;

    if (!calendar_event_id && !bot_id) return { message: "Assignment removed" };

    // Fetch with ownership join — returns null if row absent or project isn't owned by caller
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let query: any = supabase
        .from("meeting_projects")
        .select("id, kb_projects!inner(user_id)")
        .eq("kb_projects.user_id", userId);

    query = calendar_event_id
        ? query.eq("calendar_event_id", calendar_event_id)
        : query.eq("bot_id", bot_id);

    const { data, error: fetchErr } = await query.maybeSingle();
    if (fetchErr) throw new Error(fetchErr.message);
    if (!data) return { message: "Assignment removed" };

    const { error } = await supabase
        .from("meeting_projects")
        .delete()
        .eq("id", (data as any).id); // eslint-disable-line @typescript-eslint/no-explicit-any

    if (error) throw new Error(error.message);
    return { message: "Assignment removed" };
}
