import { supabase } from "../config/supabase";

export async function assertProjectAccess(args: {
    projectId: string;
    userId: string;
    userEmail: string;
    requiredRole?: "owner";
}): Promise<{ role: "owner" | "member" }> {
    const { projectId, userId, userEmail, requiredRole } = args;

    const { data: membership, error: memberErr } = await supabase
        .from("project_members")
        .select("role")
        .eq("project_id", projectId)
        .or(`user_email.eq.${userEmail},clerk_user_id.eq.${userId}`)
        .maybeSingle();

    if (memberErr) throw new Error(memberErr.message);

    if (membership) {
        const role = membership.role as "owner" | "member";
        if (requiredRole === "owner" && role !== "owner") {
            const e = new Error("Only the project owner can perform this action");
            (e as any).statusCode = 403; // eslint-disable-line @typescript-eslint/no-explicit-any
            throw e;
        }
        return { role };
    }

    const { data: project, error: projectErr } = await supabase
        .from("kb_projects")
        .select("id")
        .eq("id", projectId)
        .eq("user_id", userId)
        .maybeSingle();

    if (projectErr) throw new Error(projectErr.message);

    if (project) {
        const { error: seedErr } = await supabase
            .from("project_members")
            .insert({ project_id: projectId, user_email: userEmail, role: "owner", invited_by: userEmail, clerk_user_id: userId });
        if (seedErr) throw new Error(seedErr.message);
        return { role: "owner" };
    }

    const e = new Error("Project not found");
    (e as any).statusCode = 404; // eslint-disable-line @typescript-eslint/no-explicit-any
    throw e;
}

export async function assertProjectExists(projectId: string): Promise<{
    id: string;
    name: string;
    description: string | null;
    user_id: string;
}> {
    const { data, error } = await supabase
        .from("kb_projects")
        .select("id, name, description, user_id")
        .eq("id", projectId)
        .maybeSingle();

    if (error) throw new Error(error.message);

    if (!data) {
        const e = new Error("Project not found");
        (e as any).statusCode = 404; // eslint-disable-line @typescript-eslint/no-explicit-any
        throw e;
    }

    return data as { id: string; name: string; description: string | null; user_id: string };
}
