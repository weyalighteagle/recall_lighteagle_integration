import { useAuth } from "@clerk/react";
import { useQuery, useMutation, useQueryClient, useQueries } from "@tanstack/react-query";
import { useState, useRef, useEffect, useMemo } from "react";
import { toast } from "sonner";
import {
    Loader2, Plus, Trash2, BookOpen, Power, Pencil, Eye, Star, X, Mic,
    FolderOpen, Layers, Share2, Copy, Check, Users, LogOut,
} from "lucide-react";
import { Button } from "../components/ui/Button";
import {
    Card,
    CardContent,
    CardHeader,
    CardTitle,
    CardDescription,
} from "../components/ui/Card";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "../components/ui/Dialog";

// ─── Constants ───────────────────────────────────────────────

const CATEGORIES = [
    { value: "company_docs", label: "Company Documents" },
    { value: "faq", label: "FAQ / Product Info" },
    { value: "crm", label: "CRM / Customer" },
    { value: "transcripts", label: "Meeting History" },
];

// ─── Types ───────────────────────────────────────────────────

interface DocTag {
    id: string;
    name: string;
    color: string | null;
}

interface KBTag {
    id: string;
    name: string;
    slug: string;
    color: string | null;
    created_by: string | null;
    created_at: string;
}

interface KBDocument {
    id: string;
    title: string;
    source_type: string;
    is_active: boolean;
    created_at: string;
    category: string;
    tags: DocTag[];
}

interface TranscriptDocument {
    id: string;
    title: string;
    source_type: string;
    is_active: boolean;
    created_at: string;
    category: string;
    tags: DocTag[];
    metadata: Record<string, unknown>;
}

interface KBDocumentFull {
    id: string;
    title: string;
    category: string;
    content: string;
    source_type: string;
    is_active: boolean;
    created_at: string;
}

interface Project {
    id: string;
    name: string;
    description: string | null;
    document_count: number;
    created_at: string;
}

interface ProjectDocument {
    id: string;
    title: string;
    source_type: string;
    is_active: boolean;
    created_at: string;
}

interface ProjectDetail {
    id: string;
    name: string;
    description: string | null;
    created_at: string;
    documents: ProjectDocument[];
}

interface SharedProject {
    id: string;
    name: string;
    description: string | null;
    owner_email: string;
    member_count: number;
    joined_at: string;
}

interface Member {
    user_email: string;
    role: "owner" | "member";
    joined_at: string;
}

// ─── Small helpers ───────────────────────────────────────────

function AddToProjectDropdown({
    docId,
    projects,
    assignedProjects,
    onAdd,
}: {
    docId: string;
    projects: Project[];
    assignedProjects: Project[];
    onAdd: (projectId: string) => void;
}) {
    const [open, setOpen] = useState(false);
    const ref = useRef<HTMLDivElement>(null);
    const [localAssignedIds, setLocalAssignedIds] = useState<Set<string>>(
        () => new Set(assignedProjects.map((p) => p.id))
    );

    // Sync server-loaded assignments once project detail queries resolve
    const assignedKey = assignedProjects.map((p) => p.id).join(",");
    useEffect(() => {
        const ids = assignedKey.split(",").filter(Boolean);
        if (ids.length > 0) {
            setLocalAssignedIds((prev) => new Set([...prev, ...ids]));
        }
    }, [assignedKey]);

    useEffect(() => {
        if (!open) return;
        const handler = (e: MouseEvent) => {
            if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
        };
        document.addEventListener("mousedown", handler);
        return () => document.removeEventListener("mousedown", handler);
    }, [open]);

    const handleAdd = (projectId: string) => {
        setLocalAssignedIds((prev) => new Set([...prev, projectId]));
        onAdd(projectId);
        setOpen(false);
    };

    const assignedList = projects.filter((p) => localAssignedIds.has(p.id));
    const unassigned = projects.filter((p) => !localAssignedIds.has(p.id));

    return (
        <div className="relative flex items-center gap-1.5 flex-wrap" ref={ref}>
            {assignedList.map((p) => (
                <span
                    key={p.id}
                    className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-blue-100 text-blue-700 font-medium"
                >
                    <Layers className="size-2.5" />
                    {p.name}
                </span>
            ))}
            {projects.length > 0 && (
                <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
                    className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded border border-dashed border-blue-300 text-xs text-blue-500 hover:border-blue-400 hover:text-blue-700 transition-colors"
                >
                    <Layers className="size-3" /> project
                </button>
            )}
            {open && (
                <div className="absolute left-0 top-full mt-1 z-50 bg-white border rounded-md shadow-lg min-w-[180px] py-1">
                    {unassigned.length === 0 ? (
                        <p className="text-xs text-gray-400 px-3 py-1.5">All projects assigned</p>
                    ) : (
                        unassigned.map((project) => (
                            <button
                                key={project.id}
                                type="button"
                                onClick={(e) => { e.stopPropagation(); handleAdd(project.id); }}
                                className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-gray-50 text-left"
                            >
                                <Layers className="size-3 text-blue-400 shrink-0" />
                                <span className="truncate">{project.name}</span>
                                <span className="ml-auto text-gray-400 shrink-0">{project.document_count} docs</span>
                            </button>
                        ))
                    )}
                </div>
            )}
        </div>
    );
}

// ─── Main component ──────────────────────────────────────────

function KnowledgeBase() {
    const queryClient = useQueryClient();
    const { getToken } = useAuth();

    // ── Create form state ─────────────────────────────────────────────
    const [showForm, setShowForm] = useState(false);
    const [title, setTitle] = useState("");
    const [category, setCategory] = useState("faq");
    const [content, setContent] = useState("");

    // ── View / Edit dialog state ──────────────────────────────────────
    const [selectedDocId, setSelectedDocId] = useState<string | null>(null);
    const [isEditing, setIsEditing] = useState(false);
    const [editTitle, setEditTitle] = useState("");
    const [editCategory, setEditCategory] = useState("");
    const [editContent, setEditContent] = useState("");

    // ── Project state ─────────────────────────────────────────────
    const [showNewProjectDialog, setShowNewProjectDialog] = useState(false);
    const [newProjectName, setNewProjectName] = useState("");
    const [newProjectDescription, setNewProjectDescription] = useState("");

    const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
    const [projectToDelete, setProjectToDelete] = useState<Project | null>(null);

    const [editingProject, setEditingProject] = useState<Project | null>(null);
    const [editProjectName, setEditProjectName] = useState("");
    const [editProjectDescription, setEditProjectDescription] = useState("");

    const [showAddDocDialog, setShowAddDocDialog] = useState(false);

    const [selectedProjectRole, setSelectedProjectRole] = useState<"owner" | "member" | null>(null);

    // ── Share / invite state ──────────────────────────────────────────
    const [shareProject, setShareProject] = useState<Project | null>(null);
    const [inviteUrl, setInviteUrl] = useState<string | null>(null);
    const [isCopied, setIsCopied] = useState(false);

    // ── Queries ───────────────────────────────────────────────────────
    const { data, isPending } = useQuery<{ documents: KBDocument[] }>({
        queryKey: ["kb_documents"],
        queryFn: async () => {
            const token = await getToken();
            const res = await fetch("/api/kb", {
                headers: { Authorization: `Bearer ${token}` },
            });
            if (!res.ok) throw new Error(await res.text());
            return res.json();
        },
    });

    const { data: transcriptsData } = useQuery<{ documents: TranscriptDocument[] }>({
        queryKey: ["kb_transcripts"],
        queryFn: async () => {
            const token = await getToken();
            const res = await fetch("/api/kb/transcripts", {
                headers: { Authorization: `Bearer ${token}` },
            });
            if (!res.ok) throw new Error(await res.text());
            return res.json();
        },
    });

    const { data: fullDoc, isPending: isLoadingDoc } = useQuery<KBDocumentFull>({
        queryKey: ["kb_document", selectedDocId],
        queryFn: async () => {
            const res = await fetch(`/api/kb/${selectedDocId}`);
            if (!res.ok) throw new Error(await res.text());
            return res.json();
        },
        enabled: !!selectedDocId,
    });

    const { data: botSettings } = useQuery<{ active_kb_id: string | null }>({
        queryKey: ["bot_settings"],
        queryFn: async () => {
            const res = await fetch("/api/bot-settings");
            if (!res.ok) throw new Error(await res.text());
            return res.json();
        },
    });

    const { data: projectsData, isPending: isProjectsPending } = useQuery<{ projects: Project[] }>({
        queryKey: ["kb_projects"],
        queryFn: async () => {
            const token = await getToken();
            const res = await fetch("/api/projects", {
                headers: { Authorization: `Bearer ${token}` },
            });
            if (!res.ok) throw new Error(await res.text());
            return res.json();
        },
    });

    const { data: projectDetail, isPending: isProjectDetailPending } = useQuery<ProjectDetail>({
        queryKey: ["kb_project_detail", selectedProjectId],
        queryFn: async () => {
            const token = await getToken();
            const res = await fetch(`/api/projects/${selectedProjectId}`, {
                headers: { Authorization: `Bearer ${token}` },
            });
            if (!res.ok) throw new Error(await res.text());
            return res.json();
        },
        enabled: !!selectedProjectId,
    });

    const { data: sharedData, isPending: isSharedPending } = useQuery<{ projects: SharedProject[] }>({
        queryKey: ["shared_projects"],
        queryFn: async () => {
            const token = await getToken();
            const res = await fetch("/api/projects/shared", {
                headers: { Authorization: `Bearer ${token}` },
            });
            if (!res.ok) throw new Error(await res.text());
            return res.json();
        },
    });

    const { data: membersData, isPending: isMembersLoading } = useQuery<{ members: Member[] }>({
        queryKey: ["project_members", selectedProjectId],
        queryFn: async () => {
            const token = await getToken();
            const res = await fetch(`/api/projects/${selectedProjectId}/members`, {
                headers: { Authorization: `Bearer ${token}` },
            });
            if (!res.ok) throw new Error(await res.text());
            return res.json();
        },
        enabled: !!selectedProjectId,
    });

    const projects = projectsData?.projects ?? [];
    const sharedProjects = sharedData?.projects ?? [];

    const projectDetailQueries = useQueries({
        queries: projects.map((p) => ({
            queryKey: ["kb_project_detail", p.id] as const,
            queryFn: async () => {
                const token = await getToken();
                const res = await fetch(`/api/projects/${p.id}`, {
                    headers: { Authorization: `Bearer ${token}` },
                });
                if (!res.ok) return { id: p.id, documents: [] as Array<{ id: string }> };
                return res.json() as Promise<{ id: string; documents: Array<{ id: string }> }>;
            },
            staleTime: 60_000,
            enabled: projects.length > 0,
        })),
    });

    const docProjectsMap = useMemo(() => {
        const map = new Map<string, Project[]>();
        projectDetailQueries.forEach((query, i) => {
            const detail = query.data;
            const project = projects[i];
            if (detail && project) {
                for (const doc of detail.documents) {
                    if (!map.has(doc.id)) map.set(doc.id, []);
                    map.get(doc.id)!.push(project);
                }
            }
        });
        return map;
    }, [projectDetailQueries, projects]);

    const documents = data?.documents ?? [];
    const transcriptDocuments = transcriptsData?.documents ?? [];
    const activeKbId = botSettings?.active_kb_id ?? null;

    // ── Mutations ─────────────────────────────────────────────────────

    const invalidateBoth = () => {
        void queryClient.invalidateQueries({ queryKey: ["kb_documents"] });
        void queryClient.invalidateQueries({ queryKey: ["kb_transcripts"] });
    };

    const invalidateProjects = (projectId?: string) => {
        void queryClient.invalidateQueries({ queryKey: ["kb_projects"] });
        if (projectId) void queryClient.invalidateQueries({ queryKey: ["kb_project_detail", projectId] });
    };

    const createProjectMutation = useMutation({
        mutationFn: async () => {
            const token = await getToken();
            const res = await fetch("/api/projects", {
                method: "POST",
                headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
                body: JSON.stringify({ name: newProjectName.trim(), description: newProjectDescription.trim() || undefined }),
            });
            if (!res.ok) throw new Error(await res.text());
            return res.json() as Promise<Project>;
        },
        onSuccess: (p) => {
            toast.success(`Project "${p.name}" created`);
            setNewProjectName("");
            setNewProjectDescription("");
            setShowNewProjectDialog(false);
            invalidateProjects();
        },
        onError: (err: Error) => toast.error(err.message),
    });

    const updateProjectMutation = useMutation({
        mutationFn: async () => {
            if (!editingProject) throw new Error("No project selected");
            const token = await getToken();
            const res = await fetch(`/api/projects/${editingProject.id}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
                body: JSON.stringify({ name: editProjectName.trim(), description: editProjectDescription.trim() || null }),
            });
            if (!res.ok) throw new Error(await res.text());
            return res.json() as Promise<Project>;
        },
        onSuccess: (p) => {
            toast.success(`Project renamed to "${p.name}"`);
            setEditingProject(null);
            invalidateProjects(p.id);
        },
        onError: (err: Error) => toast.error(err.message),
    });

    const deleteProjectMutation = useMutation({
        mutationFn: async (id: string) => {
            const token = await getToken();
            const res = await fetch(`/api/projects/${id}`, {
                method: "DELETE",
                headers: { Authorization: `Bearer ${token}` },
            });
            if (!res.ok) throw new Error(await res.text());
        },
        onSuccess: () => {
            toast.success("Project deleted");
            setProjectToDelete(null);
            if (selectedProjectId === projectToDelete?.id) setSelectedProjectId(null);
            invalidateProjects();
        },
        onError: (err: Error) => toast.error(err.message),
    });

    const addDocToProjectMutation = useMutation({
        mutationFn: async ({ projectId, documentId }: { projectId: string; documentId: string }) => {
            const token = await getToken();
            const res = await fetch(`/api/projects/${projectId}/documents`, {
                method: "POST",
                headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
                body: JSON.stringify({ document_id: documentId }),
            });
            if (!res.ok) throw new Error(await res.text());
        },
        onSuccess: (_data, { projectId }) => {
            toast.success("Document added to project");
            setShowAddDocDialog(false);
            invalidateProjects(projectId);
            void queryClient.invalidateQueries({ queryKey: ["kb_project_detail"] });
        },
        onError: (err: Error) => toast.error(err.message),
    });

    const removeDocFromProjectMutation = useMutation({
        mutationFn: async ({ projectId, documentId }: { projectId: string; documentId: string }) => {
            const token = await getToken();
            const res = await fetch(`/api/projects/${projectId}/documents/${documentId}`, {
                method: "DELETE",
                headers: { Authorization: `Bearer ${token}` },
            });
            if (!res.ok) throw new Error(await res.text());
        },
        onSuccess: (_data, { projectId }) => {
            toast.success("Document removed from project");
            invalidateProjects(projectId);
        },
        onError: (err: Error) => toast.error(err.message),
    });

    const removeMemberMutation = useMutation({
        mutationFn: async ({ projectId, email }: { projectId: string; email: string }) => {
            const token = await getToken();
            const res = await fetch(`/api/projects/${projectId}/members/${encodeURIComponent(email)}`, {
                method: "DELETE",
                headers: { Authorization: `Bearer ${token}` },
            });
            if (!res.ok) throw new Error(await res.text());
        },
        onSuccess: () => {
            toast.success("Member removed");
            void queryClient.invalidateQueries({ queryKey: ["project_members", selectedProjectId] });
        },
        onError: (err: Error) => toast.error(err.message),
    });

    const leaveProjectMutation = useMutation({
        mutationFn: async (projectId: string) => {
            const token = await getToken();
            const res = await fetch(`/api/projects/${projectId}/leave`, {
                method: "POST",
                headers: { Authorization: `Bearer ${token}` },
            });
            if (!res.ok) throw new Error(await res.text());
        },
        onSuccess: () => {
            toast.success("Left project");
            setSelectedProjectId(null);
            setSelectedProjectRole(null);
            void queryClient.invalidateQueries({ queryKey: ["shared_projects"] });
        },
        onError: (err: Error) => toast.error(err.message),
    });

    const generateInviteMutation = useMutation({
        mutationFn: async (projectId: string) => {
            const token = await getToken();
            const res = await fetch(`/api/projects/${projectId}/invite`, {
                method: "POST",
                headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
                body: JSON.stringify({}),
            });
            if (!res.ok) throw new Error(await res.text());
            return res.json() as Promise<{ invite_url: string; expires_at: string }>;
        },
        onSuccess: (data) => {
            setInviteUrl(data.invite_url);
        },
        onError: (err: Error) => toast.error(err.message),
    });

    const createMutation = useMutation({
        mutationFn: async () => {
            const res = await fetch("/api/kb", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ title, category, content, tag_ids: [] }),
            });
            if (!res.ok) throw new Error(await res.text());
            return res.json() as Promise<{ document_id: string; chunks: number }>;
        },
        onSuccess: (resData) => {
            toast.success(`"${title}" added (${resData.chunks} chunks)`);
            setTitle("");
            setContent("");
            setShowForm(false);
            invalidateBoth();
        },
        onError: (err: Error) => toast.error(err.message),
    });

    const updateMutation = useMutation({
        mutationFn: async () => {
            if (!selectedDocId) throw new Error("No document selected");
            const res = await fetch(`/api/kb/${selectedDocId}`, {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ title: editTitle, category: editCategory, content: editContent }),
            });
            if (!res.ok) throw new Error(await res.text());
            return res.json() as Promise<{ document_id: string; chunks: number }>;
        },
        onSuccess: (resData) => {
            toast.success(`Updated (${resData.chunks} chunks)`);
            setIsEditing(false);
            void queryClient.invalidateQueries({ queryKey: ["kb_documents"] });
            void queryClient.invalidateQueries({ queryKey: ["kb_document", selectedDocId] });
        },
        onError: (err: Error) => toast.error(err.message),
    });

    const deleteMutation = useMutation({
        mutationFn: async (id: string) => {
            const res = await fetch(`/api/kb?id=${id}`, { method: "DELETE" });
            if (!res.ok) throw new Error(await res.text());
        },
        onSuccess: () => { toast.success("Document deleted"); invalidateBoth(); },
        onError: (err: Error) => toast.error(err.message),
    });

    const toggleMutation = useMutation({
        mutationFn: async ({ id, is_active }: { id: string; is_active: boolean }) => {
            const res = await fetch(`/api/kb?id=${id}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ is_active }),
            });
            if (!res.ok) throw new Error(await res.text());
        },
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: ["kb_documents"] });
            void queryClient.invalidateQueries({ queryKey: ["kb_transcripts"] });
        },
        onError: (err: Error) => toast.error(err.message),
    });

    const setDefaultMutation = useMutation({
        mutationFn: async (id: string) => {
            const res = await fetch("/api/bot-settings", {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ active_kb_id: id }),
            });
            if (!res.ok) throw new Error(await res.text());
        },
        onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ["bot_settings"] }); toast.success("Default KB updated"); },
        onError: (err: Error) => toast.error(err.message),
    });

    // ── Dialog handlers ───────────────────────────────────────────────
    const handleOpenDocument = (docId: string) => {
        setSelectedDocId(docId);
        setIsEditing(false);
    };

    const handleCloseDialog = () => {
        setSelectedDocId(null);
        setIsEditing(false);
        setEditTitle("");
        setEditCategory("");
        setEditContent("");
    };

    const handleStartEditing = () => {
        if (!fullDoc) return;
        setEditTitle(fullDoc.title);
        setEditCategory(fullDoc.category);
        setEditContent(fullDoc.content);
        setIsEditing(true);
    };

    const handleCancelEditing = () => {
        setIsEditing(false);
        setEditTitle("");
        setEditCategory("");
        setEditContent("");
    };

    // ── Doc row (Section 1 — manual documents only) ───────────────────
    const DocRow = ({ doc }: { doc: KBDocument }) => (
        <div
            key={doc.id}
            className={`flex items-start justify-between py-3 ${!doc.is_active ? "opacity-50" : ""}`}
        >
            <button
                type="button"
                onClick={() => handleOpenDocument(doc.id)}
                className="flex flex-col gap-1 min-w-0 flex-1 text-left hover:bg-gray-50 -mx-2 px-2 py-1 rounded-md transition-colors cursor-pointer"
            >
                <span className="text-sm font-medium text-gray-800 truncate">{doc.title}</span>
                <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-xs px-1.5 py-0.5 rounded bg-gray-100 text-gray-600">
                        {CATEGORIES.find((c) => c.value === doc.category)?.label ?? doc.category}
                    </span>
                    <span className="text-xs text-gray-400">
                        {new Date(doc.created_at).toLocaleDateString()}
                    </span>
                    <span className="text-xs text-blue-500 flex items-center gap-0.5">
                        <Eye className="size-3" /> View
                    </span>
                </div>
                <div className="flex items-center gap-1.5 flex-wrap mt-0.5" onClick={(e) => e.stopPropagation()}>
                    <AddToProjectDropdown
                        docId={doc.id}
                        projects={projects}
                        assignedProjects={docProjectsMap.get(doc.id) ?? []}
                        onAdd={(projectId) => addDocToProjectMutation.mutate({ projectId, documentId: doc.id })}
                    />
                </div>
            </button>
            <div className="flex items-center gap-1 shrink-0 ml-2 mt-1">
                <Button
                    variant="ghost"
                    size="icon-sm"
                    title={activeKbId === doc.id ? "Default KB" : "Set as default"}
                    onClick={(e) => {
                        e.stopPropagation();
                        if (activeKbId !== doc.id) setDefaultMutation.mutate(doc.id);
                    }}
                    disabled={setDefaultMutation.isPending}
                >
                    <Star className={`size-4 ${activeKbId === doc.id ? "fill-yellow-400 text-yellow-400" : "text-gray-300 hover:text-yellow-400"}`} />
                </Button>
                {activeKbId === doc.id && (
                    <span className="text-xs px-1.5 py-0.5 rounded-full bg-yellow-50 text-yellow-700 font-medium">Default</span>
                )}
                <Button
                    variant="ghost"
                    size="icon-sm"
                    title={doc.is_active ? "Deactivate" : "Activate"}
                    onClick={(e) => { e.stopPropagation(); toggleMutation.mutate({ id: doc.id, is_active: !doc.is_active }); }}
                >
                    <Power className={`size-4 ${doc.is_active ? "text-green-600" : "text-gray-400"}`} />
                </Button>
                <Button
                    variant="ghost"
                    size="icon-sm"
                    title="Delete"
                    onClick={(e) => {
                        e.stopPropagation();
                        if (confirm(`"${doc.title}" will be deleted. Are you sure?`)) deleteMutation.mutate(doc.id);
                    }}
                    className="text-red-500 hover:text-red-700"
                >
                    <Trash2 className="size-4" />
                </Button>
            </div>
        </div>
    );

    // ── Render ────────────────────────────────────────────────────────
    return (
        <div className="flex flex-col gap-4 max-w-3xl mx-auto">
            <div className="flex items-center justify-between">
                <h1 className="text-lg font-semibold">Knowledge Base</h1>
                <div className="flex items-center gap-2">
                    <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setShowNewProjectDialog(true)}
                        className="flex items-center gap-1"
                    >
                        <Layers className="size-4" />
                        New Project
                    </Button>
                    <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setShowForm(!showForm)}
                        className="flex items-center gap-1"
                    >
                        <Plus className="size-4" />
                        Add Document
                    </Button>
                </div>
            </div>

            {/* ── Add Document Form ────────────────────────────────────────── */}
            {showForm && (
                <Card>
                    <CardHeader className="pb-3">
                        <CardTitle className="text-base">New Document</CardTitle>
                        <CardDescription>
                            Paste text, select a title and category. The bot will use this information during meetings.
                        </CardDescription>
                    </CardHeader>
                    <CardContent>
                        <div className="flex flex-col gap-3">
                            <input
                                type="text"
                                placeholder="Title (e.g. Price List)"
                                value={title}
                                onChange={(e) => setTitle(e.target.value)}
                                className="w-full px-3 py-2 border rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                            />
                            <select
                                value={category}
                                onChange={(e) => setCategory(e.target.value)}
                                className="w-full px-3 py-2 border rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
                            >
                                {CATEGORIES.map((cat) => (
                                    <option key={cat.value} value={cat.value}>{cat.label}</option>
                                ))}
                            </select>
                            <textarea
                                placeholder="Paste content here..."
                                value={content}
                                onChange={(e) => setContent(e.target.value)}
                                rows={8}
                                className="w-full px-3 py-2 border rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-y"
                            />
                            <div className="flex gap-2 justify-end">
                                <Button variant="outline" size="sm" onClick={() => setShowForm(false)}>
                                    Cancel
                                </Button>
                                <Button
                                    size="sm"
                                    disabled={!title.trim() || !content.trim() || createMutation.isPending}
                                    onClick={() => createMutation.mutate()}
                                    className="flex items-center gap-2"
                                >
                                    {createMutation.isPending ? (
                                        <><Loader2 className="size-4 animate-spin" />Saving...</>
                                    ) : "Save"}
                                </Button>
                            </div>
                        </div>
                    </CardContent>
                </Card>
            )}

            {/* ── Projects grid ──────────────────────────────────────────── */}
            <div>
                <div className="flex items-center gap-2 mb-3">
                    <Layers className="size-4 text-blue-500" />
                    <h2 className="text-base font-semibold text-gray-700">Projects</h2>
                    {!isProjectsPending && (
                        <span className="text-xs text-gray-400">({projects.length})</span>
                    )}
                </div>

                {isProjectsPending ? (
                    <div className="flex items-center justify-center py-8">
                        <Loader2 className="size-6 text-blue-500 animate-spin" />
                    </div>
                ) : projects.length === 0 ? (
                    <Card className="border-dashed">
                        <CardContent className="flex flex-col items-center justify-center py-10">
                            <Layers className="size-8 text-gray-300 mb-2" />
                            <p className="text-sm text-gray-500">No projects yet</p>
                            <p className="text-xs text-gray-400 mt-1">Create a project to scope your voice agent's knowledge</p>
                            <Button
                                variant="outline"
                                size="sm"
                                className="mt-4 flex items-center gap-1"
                                onClick={() => setShowNewProjectDialog(true)}
                            >
                                <Plus className="size-4" /> New Project
                            </Button>
                        </CardContent>
                    </Card>
                ) : (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        {projects.map((project) => (
                            <Card
                                key={project.id}
                                className="group cursor-pointer hover:shadow-md transition-shadow border border-gray-200"
                                onClick={() => { setSelectedProjectId(project.id); setSelectedProjectRole("owner"); }}
                            >
                                <CardContent className="p-4 flex flex-col gap-2 min-h-[120px]">
                                    <div className="flex items-start justify-between gap-2">
                                        <div className="flex items-center gap-2 min-w-0">
                                            <span className="size-3 rounded-sm shrink-0 bg-blue-500" />
                                            <span className="text-sm font-semibold text-gray-800 truncate">{project.name}</span>
                                        </div>
                                        <div
                                            className="flex items-center gap-0.5 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
                                            onClick={(e) => e.stopPropagation()}
                                        >
                                            <Button
                                                variant="ghost"
                                                size="icon-sm"
                                                title="Share project"
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    setShareProject(project);
                                                    setInviteUrl(null);
                                                    setIsCopied(false);
                                                }}
                                            >
                                                <Share2 className="size-3.5 text-gray-400" />
                                            </Button>
                                            <Button
                                                variant="ghost"
                                                size="icon-sm"
                                                title="Edit project"
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    setEditingProject(project);
                                                    setEditProjectName(project.name);
                                                    setEditProjectDescription(project.description ?? "");
                                                }}
                                            >
                                                <Pencil className="size-3.5 text-gray-400" />
                                            </Button>
                                            <Button
                                                variant="ghost"
                                                size="icon-sm"
                                                title="Delete project"
                                                onClick={(e) => { e.stopPropagation(); setProjectToDelete(project); }}
                                                className="text-red-400 hover:text-red-600"
                                            >
                                                <Trash2 className="size-3.5" />
                                            </Button>
                                        </div>
                                    </div>
                                    {project.description && (
                                        <p className="text-xs text-gray-500 line-clamp-2 leading-relaxed">
                                            {project.description}
                                        </p>
                                    )}
                                    <div className="mt-auto flex items-center gap-1.5 pt-2">
                                        <span className="text-xs px-1.5 py-0.5 rounded-full bg-blue-50 text-blue-600 font-medium">
                                            {project.document_count} {project.document_count === 1 ? "doc" : "docs"}
                                        </span>
                                        <span className="text-xs text-gray-400">
                                            {new Date(project.created_at).toLocaleDateString()}
                                        </span>
                                    </div>
                                </CardContent>
                            </Card>
                        ))}
                    </div>
                )}
            </div>

            {/* ── Shared with me ───────────────────────────────────────────── */}
            <div>
                <div className="flex items-center gap-2 mb-3">
                    <Users className="size-4 text-purple-500" />
                    <h2 className="text-base font-semibold text-gray-700">Shared with me</h2>
                    {!isSharedPending && sharedProjects.length > 0 && (
                        <span className="text-xs text-gray-400">({sharedProjects.length})</span>
                    )}
                </div>

                {isSharedPending ? (
                    <div className="flex items-center justify-center py-4">
                        <Loader2 className="size-5 text-purple-400 animate-spin" />
                    </div>
                ) : sharedProjects.length === 0 ? (
                    <p className="text-sm text-gray-400 py-1">No shared projects yet.</p>
                ) : (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        {sharedProjects.map((project) => (
                            <Card
                                key={project.id}
                                className="cursor-pointer hover:shadow-md transition-shadow border border-purple-100"
                                onClick={() => { setSelectedProjectId(project.id); setSelectedProjectRole("member"); }}
                            >
                                <CardContent className="p-4 flex flex-col gap-2 min-h-[120px]">
                                    <div className="flex items-center gap-2 min-w-0">
                                        <span className="size-3 rounded-sm shrink-0 bg-purple-400" />
                                        <span className="text-sm font-semibold text-gray-800 truncate">{project.name}</span>
                                    </div>
                                    <p className="text-xs text-gray-500 flex items-center gap-1 truncate">
                                        <Users className="size-3 shrink-0" />
                                        Shared by {project.owner_email}
                                    </p>
                                    {project.description && (
                                        <p className="text-xs text-gray-500 line-clamp-2 leading-relaxed">
                                            {project.description}
                                        </p>
                                    )}
                                    <div className="mt-auto flex items-center gap-1.5 pt-2">
                                        <span className="text-xs px-1.5 py-0.5 rounded-full bg-purple-50 text-purple-600 font-medium">
                                            {project.member_count} {project.member_count === 1 ? "member" : "members"}
                                        </span>
                                        <span className="text-xs text-gray-400">
                                            Joined {new Date(project.joined_at).toLocaleDateString()}
                                        </span>
                                    </div>
                                </CardContent>
                            </Card>
                        ))}
                    </div>
                )}
            </div>

            {/* ── Company Documents ────────────────────────────────────────── */}
            {isPending ? (
                <Card>
                    <CardContent className="flex flex-col items-center justify-center py-12">
                        <Loader2 className="size-8 text-blue-500 mb-3 animate-spin" />
                        <p className="text-sm text-gray-500">Loading…</p>
                    </CardContent>
                </Card>
            ) : documents.length === 0 ? (
                <Card>
                    <CardContent className="flex flex-col items-center justify-center py-8">
                        <BookOpen className="size-8 text-gray-300 mb-2" />
                        <p className="text-sm text-gray-500">No documents added yet</p>
                        <p className="text-xs text-gray-400 mt-1">Use &quot;Add Document&quot; to upload information</p>
                    </CardContent>
                </Card>
            ) : (
                <Card>
                    <CardHeader className="pb-2">
                        <div className="flex items-center gap-2">
                            <BookOpen className="size-4 text-gray-400" />
                            <CardTitle className="text-sm font-semibold text-gray-700">Company Documents</CardTitle>
                            <span className="text-xs text-gray-400">({documents.length})</span>
                        </div>
                    </CardHeader>
                    <CardContent>
                        <div className="divide-y">
                            {documents.map((doc) => <DocRow key={doc.id} doc={doc} />)}
                        </div>
                    </CardContent>
                </Card>
            )}

            {/* ── View / Edit Dialog ───────────────────────────────────────── */}
            <Dialog open={!!selectedDocId} onOpenChange={(open) => { if (!open) handleCloseDialog(); }}>
                <DialogContent className="sm:max-w-2xl max-h-[85vh] overflow-y-auto">
                    {isLoadingDoc ? (
                        <div className="flex flex-col items-center justify-center py-12">
                            <Loader2 className="size-8 text-blue-500 mb-3 animate-spin" />
                            <p className="text-sm text-gray-500">Loading document…</p>
                        </div>
                    ) : !fullDoc ? (
                        <div className="py-12 text-center text-sm text-red-500">Document not found.</div>
                    ) : isEditing ? (
                        /* ── EDIT MODE ─────────────────────────────────────────── */
                        <>
                            <DialogHeader>
                                <DialogTitle className="flex items-center gap-2">
                                    <Pencil className="size-4" />
                                    Edit Document
                                </DialogTitle>
                                <DialogDescription>
                                    Edit and save. Chunks and embeddings will be regenerated on save.
                                </DialogDescription>
                            </DialogHeader>
                            <div className="flex flex-col gap-3">
                                <input
                                    type="text"
                                    value={editTitle}
                                    onChange={(e) => setEditTitle(e.target.value)}
                                    placeholder="Title"
                                    className="w-full px-3 py-2 border rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                                />
                                <select
                                    value={editCategory}
                                    onChange={(e) => setEditCategory(e.target.value)}
                                    className="w-full px-3 py-2 border rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
                                >
                                    {CATEGORIES.map((cat) => (
                                        <option key={cat.value} value={cat.value}>{cat.label}</option>
                                    ))}
                                </select>
                                <textarea
                                    value={editContent}
                                    onChange={(e) => setEditContent(e.target.value)}
                                    rows={12}
                                    className="w-full px-3 py-2 border rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-y min-h-[150px] max-h-[40vh]"
                                />
                            </div>
                            <DialogFooter>
                                <Button type="button" variant="outline" size="sm" onClick={handleCancelEditing} disabled={updateMutation.isPending}>
                                    Cancel
                                </Button>
                                <Button
                                    type="button"
                                    size="sm"
                                    disabled={!editTitle.trim() || !editContent.trim() || updateMutation.isPending}
                                    onClick={() => updateMutation.mutate()}
                                    className="flex items-center gap-2"
                                >
                                    {updateMutation.isPending ? <><Loader2 className="size-4 animate-spin" />Saving...</> : "Save"}
                                </Button>
                            </DialogFooter>
                        </>
                    ) : (
                        /* ── VIEW MODE ─────────────────────────────────────────── */
                        <>
                            <DialogHeader>
                                <DialogTitle className="flex items-center gap-2">
                                    {fullDoc.source_type === "transcript" ? (
                                        <Mic className="size-4 text-purple-500" />
                                    ) : (
                                        <BookOpen className="size-4" />
                                    )}
                                    {fullDoc.title}
                                </DialogTitle>
                                <DialogDescription className="flex items-center gap-2 flex-wrap">
                                    {fullDoc.source_type === "transcript" ? (
                                        <span className="text-xs px-1.5 py-0.5 rounded bg-purple-100 text-purple-700 flex items-center gap-0.5">
                                            <Mic className="size-3" /> Meeting Transcript
                                        </span>
                                    ) : (
                                        <span className="text-xs px-1.5 py-0.5 rounded bg-gray-100 text-gray-600">
                                            {CATEGORIES.find((c) => c.value === fullDoc.category)?.label ?? fullDoc.category}
                                        </span>
                                    )}
                                    <span className="text-xs text-gray-400">
                                        {new Date(fullDoc.created_at).toLocaleDateString()}
                                    </span>
                                    <span className={`text-xs font-medium ${fullDoc.is_active ? "text-green-600" : "text-gray-400"}`}>
                                        {fullDoc.is_active ? "Active" : "Inactive"}
                                    </span>
                                </DialogDescription>
                            </DialogHeader>
                            <div className="border rounded-md p-4 bg-gray-50 max-h-[50vh] overflow-y-auto">
                                <pre className="text-sm text-gray-700 whitespace-pre-wrap font-sans leading-relaxed">
                                    {fullDoc.content}
                                </pre>
                            </div>
                            <DialogFooter>
                                <Button type="button" variant="outline" size="sm" onClick={handleCloseDialog}>
                                    Close
                                </Button>
                                {fullDoc.source_type !== "transcript" && (
                                    <Button type="button" size="sm" onClick={handleStartEditing} className="flex items-center gap-2">
                                        <Pencil className="size-4" />
                                        Edit
                                    </Button>
                                )}
                            </DialogFooter>
                        </>
                    )}
                </DialogContent>
            </Dialog>

            {/* ── New Project Dialog ────────────────────────────────────────── */}
            <Dialog open={showNewProjectDialog} onOpenChange={(open) => { if (!open) { setShowNewProjectDialog(false); setNewProjectName(""); setNewProjectDescription(""); } }}>
                <DialogContent className="sm:max-w-sm">
                    <DialogHeader>
                        <DialogTitle className="flex items-center gap-2">
                            <Layers className="size-4" />
                            New Project
                        </DialogTitle>
                        <DialogDescription>Projects scope your voice agent to a specific set of documents.</DialogDescription>
                    </DialogHeader>
                    <div className="flex flex-col gap-3">
                        <input
                            type="text"
                            placeholder="Project name (e.g. Investor Relations)"
                            value={newProjectName}
                            onChange={(e) => setNewProjectName(e.target.value)}
                            onKeyDown={(e) => { if (e.key === "Enter" && newProjectName.trim()) createProjectMutation.mutate(); }}
                            className="w-full px-3 py-2 border rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                            autoFocus
                        />
                        <textarea
                            placeholder="Description (optional) — what is this project about?"
                            value={newProjectDescription}
                            onChange={(e) => setNewProjectDescription(e.target.value)}
                            rows={3}
                            className="w-full px-3 py-2 border rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
                        />
                    </div>
                    <DialogFooter>
                        <Button variant="outline" size="sm" onClick={() => setShowNewProjectDialog(false)}>
                            Cancel
                        </Button>
                        <Button
                            size="sm"
                            disabled={!newProjectName.trim() || createProjectMutation.isPending}
                            onClick={() => createProjectMutation.mutate()}
                            className="flex items-center gap-2"
                        >
                            {createProjectMutation.isPending ? <><Loader2 className="size-4 animate-spin" />Creating…</> : "Create Project"}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {/* ── Edit Project Dialog ───────────────────────────────────────── */}
            <Dialog open={!!editingProject} onOpenChange={(open) => { if (!open) setEditingProject(null); }}>
                <DialogContent className="sm:max-w-sm">
                    <DialogHeader>
                        <DialogTitle className="flex items-center gap-2">
                            <Pencil className="size-4" />
                            Edit Project
                        </DialogTitle>
                    </DialogHeader>
                    <div className="flex flex-col gap-3">
                        <input
                            type="text"
                            placeholder="Project name"
                            value={editProjectName}
                            onChange={(e) => setEditProjectName(e.target.value)}
                            className="w-full px-3 py-2 border rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                            autoFocus
                        />
                        <textarea
                            placeholder="Description (optional)"
                            value={editProjectDescription}
                            onChange={(e) => setEditProjectDescription(e.target.value)}
                            rows={3}
                            className="w-full px-3 py-2 border rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
                        />
                    </div>
                    <DialogFooter>
                        <Button variant="outline" size="sm" onClick={() => setEditingProject(null)}>
                            Cancel
                        </Button>
                        <Button
                            size="sm"
                            disabled={!editProjectName.trim() || updateProjectMutation.isPending}
                            onClick={() => updateProjectMutation.mutate()}
                            className="flex items-center gap-2"
                        >
                            {updateProjectMutation.isPending ? <><Loader2 className="size-4 animate-spin" />Saving…</> : "Save"}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {/* ── Delete Project Dialog ─────────────────────────────────────── */}
            <Dialog open={!!projectToDelete} onOpenChange={(open) => { if (!open) setProjectToDelete(null); }}>
                <DialogContent className="sm:max-w-sm">
                    <DialogHeader>
                        <DialogTitle className="text-red-600">Delete Project</DialogTitle>
                        <DialogDescription>
                            Delete &quot;{projectToDelete?.name}&quot;? The project will be removed but its documents will not be deleted. This cannot be undone.
                        </DialogDescription>
                    </DialogHeader>
                    <DialogFooter>
                        <Button variant="outline" size="sm" onClick={() => setProjectToDelete(null)}>
                            Cancel
                        </Button>
                        <Button
                            variant="destructive"
                            size="sm"
                            disabled={deleteProjectMutation.isPending}
                            onClick={() => projectToDelete && deleteProjectMutation.mutate(projectToDelete.id)}
                            className="flex items-center gap-2"
                        >
                            {deleteProjectMutation.isPending ? <><Loader2 className="size-4 animate-spin" />Deleting…</> : "Delete"}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {/* ── Share Project Dialog ──────────────────────────────────────── */}
            <Dialog
                open={!!shareProject}
                onOpenChange={(open) => {
                    if (!open) {
                        setShareProject(null);
                        setInviteUrl(null);
                        setIsCopied(false);
                        generateInviteMutation.reset();
                    }
                }}
            >
                <DialogContent className="sm:max-w-lg max-w-[calc(100%-2rem)]">
                    <DialogHeader>
                        <DialogTitle className="flex items-center gap-2">
                            <Share2 className="size-4" />
                            Share Project
                        </DialogTitle>
                        <DialogDescription>
                            Generate a link to invite someone to &quot;{shareProject?.name}&quot;
                        </DialogDescription>
                    </DialogHeader>

                    {inviteUrl ? (
                        <div className="flex flex-col gap-3">
                            <div className="flex items-center gap-2">
                                <input
                                    type="text"
                                    readOnly
                                    value={inviteUrl}
                                    className="flex-1 px-3 py-2 border rounded-md text-sm bg-gray-50 text-gray-700 focus:outline-none select-all"
                                    onClick={(e) => (e.target as HTMLInputElement).select()}
                                />
                                <Button
                                    size="sm"
                                    variant="outline"
                                    className="shrink-0 flex items-center gap-1.5"
                                    onClick={() => {
                                        void navigator.clipboard.writeText(inviteUrl).then(() => {
                                            setIsCopied(true);
                                            toast.success("Link copied to clipboard");
                                            setTimeout(() => setIsCopied(false), 2000);
                                        });
                                    }}
                                >
                                    {isCopied ? (
                                        <><Check className="size-4 text-green-600" />Copied</>
                                    ) : (
                                        <><Copy className="size-4" />Copy</>
                                    )}
                                </Button>
                            </div>
                            <p className="text-xs text-gray-400">Expires in 7 days</p>
                        </div>
                    ) : (
                        <p className="text-sm text-gray-500">
                            Anyone with the link can join this project. The link expires in 7 days.
                        </p>
                    )}

                    <DialogFooter>
                        <Button variant="outline" size="sm" onClick={() => setShareProject(null)}>
                            Close
                        </Button>
                        {!inviteUrl && (
                            <Button
                                size="sm"
                                disabled={generateInviteMutation.isPending}
                                onClick={() => shareProject && generateInviteMutation.mutate(shareProject.id)}
                                className="flex items-center gap-2"
                            >
                                {generateInviteMutation.isPending ? (
                                    <><Loader2 className="size-4 animate-spin" />Generating…</>
                                ) : "Generate Invite Link"}
                            </Button>
                        )}
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {/* ── Project Detail Dialog ─────────────────────────────────────── */}
            <Dialog open={!!selectedProjectId} onOpenChange={(open) => { if (!open) { setSelectedProjectId(null); setSelectedProjectRole(null); setShowAddDocDialog(false); } }}>
                <DialogContent className="sm:max-w-2xl max-h-[85vh] overflow-y-auto">
                    {isProjectDetailPending ? (
                        <div className="flex flex-col items-center justify-center py-12">
                            <Loader2 className="size-8 text-blue-500 mb-3 animate-spin" />
                            <p className="text-sm text-gray-500">Loading project…</p>
                        </div>
                    ) : !projectDetail ? (
                        <div className="py-12 text-center text-sm text-red-500">Project not found.</div>
                    ) : (
                        <>
                            <DialogHeader>
                                <DialogTitle className="flex items-center gap-2">
                                    <Layers className="size-4 text-blue-500" />
                                    {projectDetail.name}
                                </DialogTitle>
                                {projectDetail.description && (
                                    <DialogDescription>{projectDetail.description}</DialogDescription>
                                )}
                            </DialogHeader>

                            {/* Document list */}
                            <div className="flex flex-col gap-2">
                                <div className="flex items-center justify-between">
                                    <span className="text-sm font-medium text-gray-700">
                                        Documents ({projectDetail.documents.length})
                                    </span>
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        className="flex items-center gap-1"
                                        onClick={() => setShowAddDocDialog((v) => !v)}
                                    >
                                        <Plus className="size-3.5" /> Add Document
                                    </Button>
                                </div>

                                {/* Add doc picker — inline dropdown */}
                                {showAddDocDialog && (
                                    <Card className="border-blue-200 bg-blue-50">
                                        <CardContent className="p-3">
                                            <p className="text-xs text-gray-600 mb-2 font-medium">Select a document to add:</p>
                                            <div className="flex flex-col gap-1 max-h-72 overflow-y-auto">
                                                {[...documents, ...transcriptDocuments]
                                                    .filter((d) => !projectDetail.documents.some((pd) => pd.id === d.id))
                                                    .map((doc) => (
                                                        <button
                                                            key={doc.id}
                                                            type="button"
                                                            onClick={() => addDocToProjectMutation.mutate({ projectId: projectDetail.id, documentId: doc.id })}
                                                            disabled={addDocToProjectMutation.isPending}
                                                            className="flex items-center gap-2 px-2 py-1.5 rounded text-left text-xs hover:bg-white transition-colors w-full"
                                                        >
                                                            {doc.source_type === "transcript" ? (
                                                                <Mic className="size-3 text-purple-500 shrink-0" />
                                                            ) : (
                                                                <BookOpen className="size-3 text-gray-400 shrink-0" />
                                                            )}
                                                            <span className="truncate">{doc.title}</span>
                                                        </button>
                                                    ))}
                                                {[...documents, ...transcriptDocuments].filter((d) => !projectDetail.documents.some((pd) => pd.id === d.id)).length === 0 && (
                                                    <p className="text-xs text-gray-400 px-2 py-1">All documents are already in this project.</p>
                                                )}
                                            </div>
                                        </CardContent>
                                    </Card>
                                )}

                                {projectDetail.documents.length === 0 ? (
                                    <div className="flex flex-col items-center justify-center py-8 border rounded-md border-dashed">
                                        <FolderOpen className="size-7 text-gray-300 mb-2" />
                                        <p className="text-sm text-gray-400">No documents in this project yet</p>
                                    </div>
                                ) : (
                                    <div className="divide-y border rounded-md">
                                        {projectDetail.documents.map((doc) => (
                                            <div key={doc.id} className="flex items-center justify-between px-3 py-2.5">
                                                <div className="flex items-center gap-2 min-w-0">
                                                    {doc.source_type === "transcript" ? (
                                                        <Mic className="size-3.5 text-purple-500 shrink-0" />
                                                    ) : (
                                                        <BookOpen className="size-3.5 text-gray-400 shrink-0" />
                                                    )}
                                                    <span className="text-sm text-gray-700 truncate">{doc.title}</span>
                                                    <span className={`text-xs shrink-0 ${doc.is_active ? "text-green-500" : "text-gray-400"}`}>
                                                        {doc.is_active ? "Active" : "Inactive"}
                                                    </span>
                                                </div>
                                                <Button
                                                    variant="ghost"
                                                    size="icon-sm"
                                                    title="Remove from project"
                                                    disabled={removeDocFromProjectMutation.isPending}
                                                    onClick={() => removeDocFromProjectMutation.mutate({ projectId: projectDetail.id, documentId: doc.id })}
                                                    className="text-red-400 hover:text-red-600 shrink-0"
                                                >
                                                    <X className="size-4" />
                                                </Button>
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </div>

                            {/* Members section */}
                            <div className="flex flex-col gap-2">
                                <div className="flex items-center gap-2">
                                    <Users className="size-4 text-gray-500" />
                                    <span className="text-sm font-medium text-gray-700">
                                        Members{membersData ? ` (${membersData.members.length})` : ""}
                                    </span>
                                    {isMembersLoading && <Loader2 className="size-3 animate-spin text-gray-400" />}
                                </div>
                                {membersData && membersData.members.length > 0 && (
                                    <div className="divide-y border rounded-md">
                                        {membersData.members.map((member) => (
                                            <div key={member.user_email} className="flex items-center justify-between px-3 py-2">
                                                <div className="flex items-center gap-2 min-w-0">
                                                    <span className="text-sm text-gray-700 truncate">{member.user_email}</span>
                                                    <span className={`text-xs shrink-0 px-1.5 py-0.5 rounded-full font-medium ${
                                                        member.role === "owner"
                                                            ? "bg-yellow-50 text-yellow-700"
                                                            : "bg-gray-100 text-gray-600"
                                                    }`}>
                                                        {member.role === "owner" ? "Owner" : "Member"}
                                                    </span>
                                                </div>
                                                {selectedProjectRole === "owner" && member.role === "member" && (
                                                    <Button
                                                        variant="ghost"
                                                        size="icon-sm"
                                                        title="Remove member"
                                                        disabled={removeMemberMutation.isPending}
                                                        onClick={() => {
                                                            if (confirm(`Remove ${member.user_email} from this project?`)) {
                                                                removeMemberMutation.mutate({ projectId: projectDetail.id, email: member.user_email });
                                                            }
                                                        }}
                                                        className="text-red-400 hover:text-red-600 shrink-0"
                                                    >
                                                        <X className="size-4" />
                                                    </Button>
                                                )}
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </div>

                            <DialogFooter>
                                <Button variant="outline" size="sm" onClick={() => setSelectedProjectId(null)}>
                                    Close
                                </Button>
                                {selectedProjectRole === "member" && (
                                    <Button
                                        variant="destructive"
                                        size="sm"
                                        disabled={leaveProjectMutation.isPending}
                                        onClick={() => {
                                            if (selectedProjectId && confirm("Leave this project? You'll lose access to its documents.")) {
                                                leaveProjectMutation.mutate(selectedProjectId);
                                            }
                                        }}
                                        className="flex items-center gap-2"
                                    >
                                        {leaveProjectMutation.isPending
                                            ? <><Loader2 className="size-4 animate-spin" />Leaving…</>
                                            : <><LogOut className="size-4" />Leave Project</>}
                                    </Button>
                                )}
                            </DialogFooter>
                        </>
                    )}
                </DialogContent>
            </Dialog>
        </div>
    );
}

export default KnowledgeBase;
