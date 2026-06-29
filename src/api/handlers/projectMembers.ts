import { supabaseAdmin as supabase } from "../config/supabase";
import { assertProjectAccess } from "../helpers/projectAccess";

/** GET /api/projects/shared — projects where the caller is a member (not owner) */
export async function getSharedProjects(args: {
    userEmail: string;
}): Promise<Array<{
    id: string;
    name: string;
    description: string | null;
    owner_email: string;
    member_count: number;
    role: string;
    joined_at: string;
}>> {
    const { userEmail } = args;

    const { data, error } = await supabase
        .from("project_members")
        .select("role, joined_at, kb_projects(id, name, description)")
        .eq("user_email", userEmail)
        .in("role", ["admin", "member"]);

    if (error) throw new Error(error.message);

    const rows = (data ?? []) as unknown as Array<{
        role: string;
        joined_at: string;
        kb_projects: { id: string; name: string; description: string | null } | null;
    }>;

    const projectIds = rows
        .map((r) => r.kb_projects?.id)
        .filter((id): id is string => id !== undefined && id !== null);

    if (projectIds.length === 0) return [];

    const [ownersResult, countsResult] = await Promise.all([
        supabase
            .from("project_members")
            .select("project_id, user_email")
            .in("project_id", projectIds)
            .eq("role", "owner"),
        supabase
            .from("project_members")
            .select("project_id")
            .in("project_id", projectIds),
    ]);

    if (ownersResult.error) throw new Error(ownersResult.error.message);
    if (countsResult.error) throw new Error(countsResult.error.message);

    const ownerMap = new Map<string, string>(
        (ownersResult.data ?? []).map((o: { project_id: string; user_email: string }) => [o.project_id, o.user_email]),
    );

    const countMap = new Map<string, number>();
    for (const row of countsResult.data ?? []) {
        const r = row as { project_id: string };
        countMap.set(r.project_id, (countMap.get(r.project_id) ?? 0) + 1);
    }

    return rows
        .filter((r) => r.kb_projects !== null)
        .map((r) => {
            const project = r.kb_projects!;
            return {
                id: project.id,
                name: project.name,
                description: project.description,
                owner_email: ownerMap.get(project.id) ?? "",
                member_count: countMap.get(project.id) ?? 0,
                role: r.role,
                joined_at: r.joined_at,
            };
        });
}

/** GET /api/projects/:id/members — list members of a project (any member may view) */
export async function getProjectMembers(args: {
    projectId: string;
    userId: string;
    userEmail: string;
}): Promise<Array<{ user_email: string; role: string; invited_by: string; joined_at: string }>> {
    const { projectId, userId, userEmail } = args;

    await assertProjectAccess({ projectId, userId, userEmail });

    const { data, error } = await supabase
        .from("project_members")
        .select("user_email, role, invited_by, joined_at")
        .eq("project_id", projectId)
        .order("role", { ascending: false })
        .order("joined_at", { ascending: true });

    if (error) throw new Error(error.message);

    return (data ?? []) as Array<{ user_email: string; role: string; invited_by: string; joined_at: string }>;
}

/** DELETE /api/projects/:id/members/:email — owner removes another member */
export async function removeMember(args: {
    projectId: string;
    userId: string;
    userEmail: string;
    targetEmail: string;
}): Promise<{ removed: true }> {
    const { projectId, userId, userEmail, targetEmail } = args;

    await assertProjectAccess({ projectId, userId, userEmail, requiredRole: "admin" });

    if (targetEmail === userEmail) {
        const e = new Error("Cannot remove yourself. Transfer ownership first.");
        (e as any).statusCode = 400; // eslint-disable-line @typescript-eslint/no-explicit-any
        throw e;
    }

    const { data: target, error: fetchErr } = await supabase
        .from("project_members")
        .select("id, role")
        .eq("project_id", projectId)
        .eq("user_email", targetEmail)
        .maybeSingle();

    if (fetchErr) throw new Error(fetchErr.message);
    if (!target) {
        const e = new Error("Member not found");
        (e as any).statusCode = 404; // eslint-disable-line @typescript-eslint/no-explicit-any
        throw e;
    }

    if ((target as any).role === "owner") { // eslint-disable-line @typescript-eslint/no-explicit-any
        const e = new Error("The project owner cannot be removed");
        (e as any).statusCode = 403; // eslint-disable-line @typescript-eslint/no-explicit-any
        throw e;
    }

    const { error } = await supabase
        .from("project_members")
        .delete()
        .eq("project_id", projectId)
        .eq("user_email", targetEmail);

    if (error) throw new Error(error.message);

    console.log(`[projectMembers] Owner ${userEmail} removed ${targetEmail} from project ${projectId}`);
    return { removed: true };
}

/** PATCH /api/projects/:id/members/:email — admin changes a member's role */
export async function changeMemberRole(args: {
    projectId: string;
    targetEmail: string;
    newRole: string;
}): Promise<{ user_email: string; role: string; invited_by: string; joined_at: string }> {
    const { projectId, targetEmail, newRole } = args;

    if (newRole !== "admin" && newRole !== "member") {
        const e = new Error("role must be 'admin' or 'member'");
        (e as any).statusCode = 400; // eslint-disable-line @typescript-eslint/no-explicit-any
        throw e;
    }

    const { data: target, error: fetchErr } = await supabase
        .from("project_members")
        .select("user_email, role, invited_by, joined_at")
        .eq("project_id", projectId)
        .eq("user_email", targetEmail)
        .maybeSingle();

    if (fetchErr) throw new Error(fetchErr.message);
    if (!target) {
        const e = new Error("Member not found");
        (e as any).statusCode = 404; // eslint-disable-line @typescript-eslint/no-explicit-any
        throw e;
    }

    const t = target as { user_email: string; role: string; invited_by: string; joined_at: string }; // eslint-disable-line @typescript-eslint/no-explicit-any

    if (t.role === "owner") {
        const e = new Error("The project owner's role cannot be changed");
        (e as any).statusCode = 403; // eslint-disable-line @typescript-eslint/no-explicit-any
        throw e;
    }

    if (t.role === newRole) {
        return t;
    }

    const { data: updated, error: updateErr } = await supabase
        .from("project_members")
        .update({ role: newRole })
        .eq("project_id", projectId)
        .eq("user_email", targetEmail)
        .select("user_email, role, invited_by, joined_at")
        .single();

    if (updateErr) throw new Error(updateErr.message);

    console.log(`[projectMembers] ${targetEmail} role changed to ${newRole} in project ${projectId}`);
    return updated as { user_email: string; role: string; invited_by: string; joined_at: string };
}

/** POST /api/projects/:id/leave — non-owner member leaves a project */
export async function leaveProject(args: {
    projectId: string;
    userId: string;
    userEmail: string;
}): Promise<{ left: true }> {
    const { projectId, userId, userEmail } = args;

    const { role } = await assertProjectAccess({ projectId, userId, userEmail });

    if (role === "owner") {
        const e = new Error("Project owner cannot leave. Transfer ownership or delete the project.");
        (e as any).statusCode = 400; // eslint-disable-line @typescript-eslint/no-explicit-any
        throw e;
    }

    const { error } = await supabase
        .from("project_members")
        .delete()
        .eq("project_id", projectId)
        .eq("user_email", userEmail);

    if (error) throw new Error(error.message);

    console.log(`[projectMembers] ${userEmail} left project ${projectId}`);
    return { left: true };
}
