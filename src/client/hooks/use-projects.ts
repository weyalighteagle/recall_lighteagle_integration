import { useAuth } from "@clerk/react";
import { useQuery } from "@tanstack/react-query";

export interface ProjectOption {
    id: string;
    name: string;
    description: string | null;
    isShared: boolean;
    ownerEmail?: string;
    documentCount?: number;
}

interface OwnedProjectsResponse {
    projects: Array<{
        id: string;
        name: string;
        description: string | null;
        document_count: number;
        created_at: string;
    }>;
}

type SharedProjectsResponse = Array<{
    id: string;
    name: string;
    description: string | null;
    owner_email: string;
    member_count: number;
    role: string;
    joined_at: string;
}>;

/**
 * Shared hook for fetching the caller's KB projects — both owned (GET /api/projects,
 * response wrapped in { projects }) and shared (GET /api/projects/shared, response is
 * a bare array). Callers that need to distinguish the two should use ownedProjects /
 * sharedProjects directly; callers that just need "everywhere I can pick a project"
 * should use allProjects.
 */
export function useProjects() {
    const { getToken, isSignedIn } = useAuth();

    const { data: ownedProjects = [], isPending: ownedPending, error: ownedError } = useQuery({
        queryKey: ["kb_projects"],
        queryFn: async (): Promise<ProjectOption[]> => {
            const token = await getToken();
            const res = await fetch("/api/projects", {
                headers: { Authorization: `Bearer ${token}` },
            });
            if (!res.ok) throw new Error(await res.text());
            const data = (await res.json()) as OwnedProjectsResponse;
            return data.projects.map((p) => ({
                id: p.id,
                name: p.name,
                description: p.description,
                isShared: false,
                documentCount: p.document_count,
            }));
        },
        enabled: !!isSignedIn,
    });

    const { data: sharedProjects = [], isPending: sharedPending, error: sharedError } = useQuery({
        queryKey: ["shared_projects"],
        queryFn: async (): Promise<ProjectOption[]> => {
            const token = await getToken();
            const res = await fetch("/api/projects/shared", {
                headers: { Authorization: `Bearer ${token}` },
            });
            if (!res.ok) throw new Error(await res.text());
            const data = (await res.json()) as SharedProjectsResponse;
            return data.map((p) => ({
                id: p.id,
                name: p.name,
                description: p.description,
                isShared: true,
                ownerEmail: p.owner_email,
            }));
        },
        enabled: !!isSignedIn,
    });

    return {
        ownedProjects,
        sharedProjects,
        allProjects: [...ownedProjects, ...sharedProjects],
        isLoading: ownedPending || sharedPending,
        error: ownedError ?? sharedError ?? null,
    };
}
