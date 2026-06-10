import { z } from "zod";
import { supabase } from "../config/supabase";
import { assertProjectAccess } from "../helpers/projectAccess";

// ─── Types ───────────────────────────────────────────────────

interface ProjectRow {
    id: string;
    name: string;
    description: string | null;
    created_at: string;
}

// ─── Helpers ─────────────────────────────────────────────────

function notFound(): never {
    const e = new Error("Project not found");
    (e as any).statusCode = 404; // eslint-disable-line @typescript-eslint/no-explicit-any
    throw e;
}

// ─── Handlers ────────────────────────────────────────────────

/** GET /api/projects — list caller's projects with document counts */
export async function project_list(userId: string): Promise<{
    projects: Array<{
        id: string;
        name: string;
        description: string | null;
        document_count: number;
        created_at: string;
    }>;
}> {
    const { data, error } = await supabase
        .from("kb_projects")
        .select("id, name, description, created_at, kb_document_projects(count)")
        .eq("user_id", userId)
        .order("created_at", { ascending: false });

    if (error) throw new Error(error.message);

    const projects = (data ?? []).map((p: any) => ({ // eslint-disable-line @typescript-eslint/no-explicit-any
        id: p.id as string,
        name: p.name as string,
        description: p.description as string | null,
        document_count: ((p.kb_document_projects as Array<{ count: number }> | null)?.[0]?.count ?? 0),
        created_at: p.created_at as string,
    }));

    return { projects };
}

/** POST /api/projects — create a project for the caller */
export async function project_create(
    body: { name: string; description?: string },
    userId: string,
): Promise<ProjectRow> {
    const { name, description } = z.object({
        name: z.string().min(1),
        description: z.string().optional(),
    }).parse(body);

    const { data, error } = await supabase
        .from("kb_projects")
        .insert({ name, description: description ?? null, user_id: userId })
        .select("id, name, description, created_at")
        .single();

    if (error) {
        if (error.code === "23505") {
            const e = new Error(`A project named "${name}" already exists`);
            (e as any).statusCode = 409; // eslint-disable-line @typescript-eslint/no-explicit-any
            throw e;
        }
        throw new Error(error.message);
    }

    console.log(`[projects] Created "${name}" (${data.id})`);
    return data as ProjectRow;
}

/** GET /api/projects/:id — single project with its documents (caller-owned only) */
export async function project_get(
    projectId: string,
    userId: string,
    userEmail: string,
): Promise<{
    id: string;
    name: string;
    description: string | null;
    created_at: string;
    documents: Array<{
        id: string;
        title: string;
        source_type: string;
        is_active: boolean;
        created_at: string;
    }>;
}> {
    const validId = z.string().uuid().parse(projectId);
    await assertProjectAccess({ projectId: validId, userId, userEmail });

    const { data: project, error } = await supabase
        .from("kb_projects")
        .select(`
            id, name, description, created_at,
            kb_document_projects(
                kb_documents(id, title, source_type, is_active, created_at)
            )
        `)
        .eq("id", validId)
        .maybeSingle();

    if (error) throw new Error(error.message);
    if (!project) notFound();

    const documents = ((project as any).kb_document_projects ?? []) // eslint-disable-line @typescript-eslint/no-explicit-any
        .map((row: any) => row.kb_documents) // eslint-disable-line @typescript-eslint/no-explicit-any
        .filter((doc: any): doc is { id: string; title: string; source_type: string; is_active: boolean; created_at: string } => doc !== null); // eslint-disable-line @typescript-eslint/no-explicit-any

    return {
        id: (project as any).id, // eslint-disable-line @typescript-eslint/no-explicit-any
        name: (project as any).name, // eslint-disable-line @typescript-eslint/no-explicit-any
        description: (project as any).description, // eslint-disable-line @typescript-eslint/no-explicit-any
        created_at: (project as any).created_at, // eslint-disable-line @typescript-eslint/no-explicit-any
        documents,
    };
}

/** PATCH /api/projects/:id — rename or re-describe a project (caller-owned only) */
export async function project_update(
    projectId: string,
    body: { name?: string; description?: string | null },
    userId: string,
    userEmail: string,
): Promise<ProjectRow> {
    const validId = z.string().uuid().parse(projectId);
    await assertProjectAccess({ projectId: validId, userId, userEmail, requiredRole: "owner" });

    const { name, description } = z.object({
        name: z.string().min(1).optional(),
        description: z.string().nullable().optional(),
    }).parse(body);

    const updates: Record<string, unknown> = {};
    if (name !== undefined) updates.name = name;
    if (description !== undefined) updates.description = description;

    if (Object.keys(updates).length === 0) throw new Error("No fields to update");

    const { data, error } = await supabase
        .from("kb_projects")
        .update(updates)
        .eq("id", validId)
        .select("id, name, description, created_at")
        .single();

    if (error) {
        if (error.code === "23505") {
            const e = new Error("A project with that name already exists");
            (e as any).statusCode = 409; // eslint-disable-line @typescript-eslint/no-explicit-any
            throw e;
        }
        throw new Error(error.message);
    }

    console.log(`[projects] Updated project ${validId}`);
    return data as ProjectRow;
}

/** DELETE /api/projects/:id — delete a project (cascade removes kb_document_projects and meeting_projects; documents are NOT deleted) */
export async function project_delete(projectId: string, userId: string, userEmail: string): Promise<void> {
    const validId = z.string().uuid().parse(projectId);
    await assertProjectAccess({ projectId: validId, userId, userEmail, requiredRole: "owner" });

    const { error } = await supabase
        .from("kb_projects")
        .delete()
        .eq("id", validId);

    if (error) throw new Error(error.message);
    console.log(`[projects] Deleted project ${validId}`);
}

/** POST /api/projects/:id/documents — add an existing document to a project (idempotent) */
export async function project_document_add(
    projectId: string,
    documentId: string,
    userId: string,
    userEmail: string,
): Promise<{ message: string }> {
    const validProjectId = z.string().uuid().parse(projectId);
    const validDocumentId = z.string().uuid().parse(documentId);
    await assertProjectAccess({ projectId: validProjectId, userId, userEmail });

    const { data: doc, error: docErr } = await supabase
        .from("kb_documents")
        .select("id")
        .eq("id", validDocumentId)
        .maybeSingle();

    if (docErr) throw new Error(docErr.message);
    if (!doc) {
        const e = new Error("Document not found");
        (e as any).statusCode = 404; // eslint-disable-line @typescript-eslint/no-explicit-any
        throw e;
    }

    const { error } = await supabase
        .from("kb_document_projects")
        .insert({ project_id: validProjectId, document_id: validDocumentId });

    if (error && error.code !== "23505") throw new Error(error.message);

    console.log(`[projects] Added document ${validDocumentId} to project ${validProjectId}`);
    return { message: "Document added to project" };
}

/** DELETE /api/projects/:id/documents/:docId — remove a document from a project (document itself is NOT deleted).
 *  Pass ?bot_id=... to also clean up the meeting_projects row so auto-link doesn't re-fire on next ingest. */
export async function project_document_remove(
    projectId: string,
    docId: string,
    userId: string,
    userEmail: string,
    botId?: string,
): Promise<{ message: string }> {
    const validProjectId = z.string().uuid().parse(projectId);
    const validDocId = z.string().uuid().parse(docId);
    await assertProjectAccess({ projectId: validProjectId, userId, userEmail, requiredRole: "owner" });

    const { error } = await supabase
        .from("kb_document_projects")
        .delete()
        .eq("project_id", validProjectId)
        .eq("document_id", validDocId);

    if (error) throw new Error(error.message);

    console.log(`[projects] Removed document ${validDocId} from project ${validProjectId}`);

    // Clean up meeting_projects so auto-link doesn't re-create the row on next ingest.
    // Try bot_id column first (instant-meeting bots), then fall back to calendar_event_id
    // (calendar bots whose meeting_projects row has bot_id = null).
    if (botId) {
        const { data: mpByBot } = await supabase
            .from("meeting_projects")
            .select("id, kb_projects!inner(user_id)")
            .eq("kb_projects.user_id", userId)
            .eq("bot_id", botId)
            .maybeSingle();

        if (mpByBot) {
            await supabase.from("meeting_projects").delete().eq("id", (mpByBot as any).id); // eslint-disable-line @typescript-eslint/no-explicit-any
            console.log(`[projects] Removed meeting_projects row for bot_id=${botId}`);
        } else {
            const { data: meetingRow } = await supabase
                .from("meetings")
                .select("calendar_event_id")
                .eq("bot_id", botId)
                .maybeSingle();

            if (meetingRow?.calendar_event_id) {
                const { data: mpByEvent } = await supabase
                    .from("meeting_projects")
                    .select("id, kb_projects!inner(user_id)")
                    .eq("kb_projects.user_id", userId)
                    .eq("calendar_event_id", meetingRow.calendar_event_id)
                    .maybeSingle();

                if (mpByEvent) {
                    await supabase.from("meeting_projects").delete().eq("id", (mpByEvent as any).id); // eslint-disable-line @typescript-eslint/no-explicit-any
                    console.log(`[projects] Removed meeting_projects row for calendar_event_id=${meetingRow.calendar_event_id}`);
                }
            }
        }
    }

    return { message: "Document removed from project" };
}
