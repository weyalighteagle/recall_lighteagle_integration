import { supabaseAdmin as supabase } from "../config/supabase";

// ─── Helpers ─────────────────────────────────────────────────

function notFound(msg = "Invitation not found"): never {
    const e = new Error(msg);
    (e as any).statusCode = 404; // eslint-disable-line @typescript-eslint/no-explicit-any
    throw e;
}

// ─── Handlers ────────────────────────────────────────────────

/** POST /api/projects/:id/invitations — generate an invite link for a project */
export async function createInvite(args: {
    projectId: string;
    userId: string;
    userEmail: string;
    invitedEmail?: string;
    role?: string;
}): Promise<{ invite_token: string; invite_url: string }> {
    const { projectId, userId, userEmail, invitedEmail, role: rawRole } = args;

    const inviteRole = rawRole ?? "member";
    if (inviteRole !== "admin" && inviteRole !== "member") {
        const e = new Error("role must be 'admin' or 'member'");
        (e as any).statusCode = 400; // eslint-disable-line @typescript-eslint/no-explicit-any
        throw e;
    }

    const { data: project, error: projectErr } = await supabase
        .from("kb_projects")
        .select("id, name, user_id")
        .eq("id", projectId)
        .maybeSingle();

    if (projectErr) throw new Error(projectErr.message);
    if (!project) notFound("Project not found");

    const { data: membership, error: memberErr } = await supabase
        .from("project_members")
        .select("role")
        .eq("project_id", projectId)
        .eq("user_email", userEmail)
        .maybeSingle();

    if (memberErr) throw new Error(memberErr.message);
    if (!membership) {
        if (project.user_id === userId) {
            const { error: seedErr } = await supabase
                .from("project_members")
                .insert({ project_id: projectId, user_email: userEmail, role: "owner", invited_by: userEmail, clerk_user_id: userId });
            if (seedErr) throw new Error(seedErr.message);
        } else {
            const e = new Error("Not authorized");
            (e as any).statusCode = 403; // eslint-disable-line @typescript-eslint/no-explicit-any
            throw e;
        }
    }

    if (invitedEmail && invitedEmail === userEmail) {
        const e = new Error("Cannot invite yourself");
        (e as any).statusCode = 400; // eslint-disable-line @typescript-eslint/no-explicit-any
        throw e;
    }

    if (invitedEmail) {
        const { data: existingMember, error: existingErr } = await supabase
            .from("project_members")
            .select("id")
            .eq("project_id", projectId)
            .eq("user_email", invitedEmail)
            .maybeSingle();

        if (existingErr) throw new Error(existingErr.message);
        if (existingMember) {
            const e = new Error("User is already a project member");
            (e as any).statusCode = 409; // eslint-disable-line @typescript-eslint/no-explicit-any
            throw e;
        }
    }

    const { data: invitation, error: insertErr } = await supabase
        .from("project_invitations")
        .insert({
            project_id: projectId,
            invited_email: invitedEmail ?? null,
            invited_by: userEmail,
            status: "pending",
            role: inviteRole,
        })
        .select("invite_token")
        .single();

    if (insertErr) throw new Error(insertErr.message);

    const invite_token: string = (invitation as any).invite_token; // eslint-disable-line @typescript-eslint/no-explicit-any
    const invite_url = `${process.env.CLIENT_DOMAIN || "http://localhost:5173"}/invite/${invite_token}`;

    console.log(`[invitations] Created invite token ${invite_token} for project ${projectId} by ${userEmail}`);
    return { invite_token, invite_url };
}

/** GET /api/invitations/:token — resolve an invite token to project + status metadata */
export async function getInvitation(args: {
    token: string;
}): Promise<{
    project_name: string;
    invited_by: string;
    invited_email: string | null;
    status: string;
    expires_at: string;
    role: string;
}> {
    const { token } = args;

    const { data: row, error } = await supabase
        .from("project_invitations")
        .select("*, kb_projects(name)")
        .eq("invite_token", token)
        .maybeSingle();

    if (error) throw new Error(error.message);
    if (!row) notFound();

    const r = row as any; // eslint-disable-line @typescript-eslint/no-explicit-any

    if (r.status === "pending" && new Date(r.expires_at) < new Date()) {
        const { error: updateErr } = await supabase
            .from("project_invitations")
            .update({ status: "expired" })
            .eq("id", r.id);

        if (updateErr) throw new Error(updateErr.message);
        r.status = "expired";
    }

    return {
        project_name: r.kb_projects.name as string,
        invited_by: r.invited_by as string,
        invited_email: r.invited_email as string | null,
        status: r.status as string,
        expires_at: r.expires_at as string,
        role: (r.role ?? "member") as string,
    };
}

/** POST /api/invitations/:token/accept — accept an invite and join a project */
export async function acceptInvitation(args: {
    token: string;
    userId: string;
    userEmail: string;
}): Promise<{ project_id: string; project_name: string; role: string }> {
    const { token, userId, userEmail } = args;

    const { data: row, error } = await supabase
        .from("project_invitations")
        .select("*, kb_projects(id, name, user_id)")
        .eq("invite_token", token)
        .maybeSingle();

    if (error) throw new Error(error.message);
    if (!row) notFound();

    const r = row as any; // eslint-disable-line @typescript-eslint/no-explicit-any

    if (r.status === "accepted") {
        const e = new Error("Invitation already accepted");
        (e as any).statusCode = 410; // eslint-disable-line @typescript-eslint/no-explicit-any
        throw e;
    }

    if (r.status === "expired" || new Date(r.expires_at) < new Date()) {
        const e = new Error("Invitation has expired");
        (e as any).statusCode = 410; // eslint-disable-line @typescript-eslint/no-explicit-any
        throw e;
    }

    if (r.invited_email && r.invited_email !== userEmail) {
        const e = new Error("This invitation was sent to a different email address");
        (e as any).statusCode = 403; // eslint-disable-line @typescript-eslint/no-explicit-any
        throw e;
    }

    if (r.kb_projects.user_id === userId) {
        const e = new Error("You are already the owner of this project");
        (e as any).statusCode = 409; // eslint-disable-line @typescript-eslint/no-explicit-any
        throw e;
    }

    const { data: existingMember, error: memberErr } = await supabase
        .from("project_members")
        .select("id, role")
        .eq("project_id", r.project_id)
        .eq("user_email", userEmail)
        .maybeSingle();

    if (memberErr) throw new Error(memberErr.message);
    if (existingMember) {
        return {
            project_id: r.project_id as string,
            project_name: r.kb_projects.name as string,
            role: (existingMember as any).role as string, // eslint-disable-line @typescript-eslint/no-explicit-any
        };
    }

    const grantedRole: string = r.role ?? "member";

    const { error: insertErr } = await supabase
        .from("project_members")
        .insert({
            project_id: r.project_id,
            user_email: userEmail,
            role: grantedRole,
            invited_by: r.invited_by,
            clerk_user_id: userId,
        });

    if (insertErr) throw new Error(insertErr.message);

    const { error: updateErr } = await supabase
        .from("project_invitations")
        .update({ status: "accepted" })
        .eq("id", r.id);

    if (updateErr) throw new Error(updateErr.message);

    console.log(`[invitations] ${userEmail} accepted invite ${token} for project ${r.project_id} as ${grantedRole}`);
    return {
        project_id: r.project_id as string,
        project_name: r.kb_projects.name as string,
        role: grantedRole,
    };
}
