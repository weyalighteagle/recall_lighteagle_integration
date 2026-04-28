import { useAuth } from "@clerk/react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, useRef, useEffect } from "react";
import { toast } from "sonner";
import {
    Loader2, Plus, Trash2, BookOpen, Power, Pencil, Eye, Star, Tag, X, Mic,
} from "lucide-react";
import { Button } from "../components/ui/Button";
import {
    Card,
    CardContent,
    CardHeader,
    CardTitle,
    CardDescription,
} from "../components/ui/Card";
import { ScrollArea } from "../components/ui/ScrollArea";
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

// ─── Small helpers ───────────────────────────────────────────

function TagPill({
    tag,
    onRemove,
}: {
    tag: DocTag;
    onRemove?: () => void;
}) {
    const bg = tag.color ?? "#6b7280";
    return (
        <span
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium text-white"
            style={{ backgroundColor: bg }}
        >
            {tag.name}
            {onRemove && (
                <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); onRemove(); }}
                    className="hover:opacity-70 transition-opacity"
                    aria-label={`Remove tag ${tag.name}`}
                >
                    <X className="size-2.5" />
                </button>
            )}
        </span>
    );
}

function AddTagDropdown({
    docId,
    allTags,
    docTagIds,
    onAdd,
}: {
    docId: string;
    allTags: KBTag[];
    docTagIds: string[];
    onAdd: (tagId: string) => void;
}) {
    const [open, setOpen] = useState(false);
    const ref = useRef<HTMLDivElement>(null);
    const available = allTags.filter((t) => !docTagIds.includes(t.id));

    useEffect(() => {
        if (!open) return;
        const handler = (e: MouseEvent) => {
            if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
        };
        document.addEventListener("mousedown", handler);
        return () => document.removeEventListener("mousedown", handler);
    }, [open]);

    if (available.length === 0) return null;

    return (
        <div className="relative" ref={ref}>
            <button
                type="button"
                onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
                className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded border border-dashed border-gray-300 text-xs text-gray-500 hover:border-gray-400 hover:text-gray-700 transition-colors"
            >
                <Plus className="size-3" /> tag
            </button>
            {open && (
                <div className="absolute left-0 top-full mt-1 z-50 bg-white border rounded-md shadow-lg min-w-[140px] py-1">
                    {available.map((tag) => (
                        <button
                            key={tag.id}
                            type="button"
                            onClick={(e) => {
                                e.stopPropagation();
                                onAdd(tag.id);
                                setOpen(false);
                            }}
                            className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-gray-50 text-left"
                        >
                            <span
                                className="size-2.5 rounded-full shrink-0"
                                style={{ backgroundColor: tag.color ?? "#6b7280" }}
                            />
                            {tag.name}
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
}

// ─── Inline rename input for a tag section header ────────────

function InlineRename({
    initialValue,
    onCommit,
    onCancel,
}: {
    initialValue: string;
    onCommit: (value: string) => void;
    onCancel: () => void;
}) {
    const [value, setValue] = useState(initialValue);
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => { inputRef.current?.focus(); inputRef.current?.select(); }, []);

    const commit = () => {
        const trimmed = value.trim();
        if (trimmed && trimmed !== initialValue) onCommit(trimmed);
        else onCancel();
    };

    return (
        <input
            ref={inputRef}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
                if (e.key === "Enter") commit();
                if (e.key === "Escape") onCancel();
            }}
            className="text-sm font-semibold bg-transparent border-b border-blue-400 outline-none px-0.5"
            style={{ width: `${Math.max(value.length, 4)}ch` }}
        />
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
    const [createTagIds, setCreateTagIds] = useState<string[]>([]);

    // ── View / Edit dialog state ──────────────────────────────────────
    const [selectedDocId, setSelectedDocId] = useState<string | null>(null);
    const [isEditing, setIsEditing] = useState(false);
    const [editTitle, setEditTitle] = useState("");
    const [editCategory, setEditCategory] = useState("");
    const [editContent, setEditContent] = useState("");

    // ── New tag dialog state ──────────────────────────────────────────
    const [showNewTagDialog, setShowNewTagDialog] = useState(false);
    const [newTagName, setNewTagName] = useState("");
    const [newTagColor, setNewTagColor] = useState("#3b82f6");

    // ── Delete tag dialog state ───────────────────────────────────────
    const [tagToDelete, setTagToDelete] = useState<KBTag | null>(null);

    // ── Inline rename state ───────────────────────────────────────────
    const [renamingTagId, setRenamingTagId] = useState<string | null>(null);

    // ── Queries ───────────────────────────────────────────────────────
    const { data, isPending } = useQuery<{ documents: KBDocument[] }>({
        queryKey: ["kb_documents"],
        queryFn: async () => {
            const res = await fetch("/api/kb");
            if (!res.ok) throw new Error(await res.text());
            return res.json();
        },
    });

    const { data: transcriptsData, isPending: isTranscriptsPending } = useQuery<{ documents: TranscriptDocument[] }>({
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

    const { data: tagsData } = useQuery<{ tags: KBTag[] }>({
        queryKey: ["kb_tags"],
        queryFn: async () => {
            const res = await fetch("/api/kb/tags");
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

    const documents = data?.documents ?? [];
    const transcriptDocuments = transcriptsData?.documents ?? [];
    const allTags = tagsData?.tags ?? [];
    const activeKbId = botSettings?.active_kb_id ?? null;

    // ── Group documents by tags ───────────────────────────────────────
    // A doc appears in every section its tags belong to; tagless docs go to Uncategorized.
    const taggedSections = allTags.map((tag) => ({
        tag,
        docs: documents.filter((d) => d.tags.some((t) => t.id === tag.id)),
    }));
    const untaggedDocs = documents.filter((d) => d.tags.length === 0);

    // ── Group transcripts by tags (same tag taxonomy, separate section) ──
    const transcriptTaggedSections = allTags.map((tag) => ({
        tag,
        docs: transcriptDocuments.filter((d) => d.tags.some((t) => t.id === tag.id)),
    })).filter(({ docs }) => docs.length > 0);
    const untaggedTranscripts = transcriptDocuments.filter((d) => d.tags.length === 0);

    // ── Mutations ─────────────────────────────────────────────────────

    const invalidateBoth = () => {
        void queryClient.invalidateQueries({ queryKey: ["kb_documents"] });
        void queryClient.invalidateQueries({ queryKey: ["kb_tags"] });
        void queryClient.invalidateQueries({ queryKey: ["kb_transcripts"] });
    };

    const createMutation = useMutation({
        mutationFn: async () => {
            const res = await fetch("/api/kb", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ title, category, content, tag_ids: createTagIds }),
            });
            if (!res.ok) throw new Error(await res.text());
            return res.json() as Promise<{ document_id: string; chunks: number }>;
        },
        onSuccess: (resData) => {
            toast.success(`"${title}" added (${resData.chunks} chunks)`);
            setTitle("");
            setContent("");
            setCreateTagIds([]);
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

    const createTagMutation = useMutation({
        mutationFn: async () => {
            const token = await getToken();
            const res = await fetch("/api/kb/tags", {
                method: "POST",
                headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
                body: JSON.stringify({ name: newTagName, color: newTagColor }),
            });
            if (!res.ok) throw new Error(await res.text());
            return res.json() as Promise<KBTag>;
        },
        onSuccess: (tag) => {
            toast.success(`Category "${tag.name}" created`);
            setNewTagName("");
            setNewTagColor("#3b82f6");
            setShowNewTagDialog(false);
            invalidateBoth();
        },
        onError: (err: Error) => toast.error(err.message),
    });

    const renameTagMutation = useMutation({
        mutationFn: async ({ id, name }: { id: string; name: string }) => {
            const token = await getToken();
            const res = await fetch(`/api/kb/tags/${id}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
                body: JSON.stringify({ name }),
            });
            if (!res.ok) throw new Error(await res.text());
            return res.json() as Promise<KBTag>;
        },
        onSuccess: (tag) => {
            toast.success(`Renamed to "${tag.name}"`);
            setRenamingTagId(null);
            invalidateBoth();
        },
        onError: (err: Error) => { toast.error(err.message); setRenamingTagId(null); },
    });

    const deleteTagMutation = useMutation({
        mutationFn: async (id: string) => {
            const token = await getToken();
            const res = await fetch(`/api/kb/tags/${id}`, {
                method: "DELETE",
                headers: { Authorization: `Bearer ${token}` },
            });
            if (!res.ok) throw new Error(await res.text());
        },
        onSuccess: () => {
            toast.success("Category deleted");
            setTagToDelete(null);
            invalidateBoth();
        },
        onError: (err: Error) => { toast.error(err.message); setTagToDelete(null); },
    });

    const addDocTagMutation = useMutation({
        mutationFn: async ({ docId, tagId }: { docId: string; tagId: string }) => {
            const token = await getToken();
            const res = await fetch(`/api/kb/${docId}/tags`, {
                method: "POST",
                headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
                body: JSON.stringify({ tag_id: tagId }),
            });
            if (!res.ok) throw new Error(await res.text());
        },
        onSuccess: () => invalidateBoth(),
        onError: (err: Error) => toast.error(err.message),
    });

    const removeDocTagMutation = useMutation({
        mutationFn: async ({ docId, tagId }: { docId: string; tagId: string }) => {
            const token = await getToken();
            const res = await fetch(`/api/kb/${docId}/tags/${tagId}`, {
                method: "DELETE",
                headers: { Authorization: `Bearer ${token}` },
            });
            if (!res.ok) throw new Error(await res.text());
        },
        onSuccess: () => invalidateBoth(),
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
                {/* Tag pills */}
                <div className="flex items-center gap-1.5 flex-wrap mt-0.5" onClick={(e) => e.stopPropagation()}>
                    {doc.tags.map((tag) => (
                        <TagPill
                            key={tag.id}
                            tag={tag}
                            onRemove={() => removeDocTagMutation.mutate({ docId: doc.id, tagId: tag.id })}
                        />
                    ))}
                    <AddTagDropdown
                        docId={doc.id}
                        allTags={allTags}
                        docTagIds={doc.tags.map((t) => t.id)}
                        onAdd={(tagId) => addDocTagMutation.mutate({ docId: doc.id, tagId })}
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

    // ── Transcript row (Section 2 — read-only, no rename) ─────────────
    const TranscriptRow = ({ doc }: { doc: TranscriptDocument }) => (
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
                    <span className="text-xs px-1.5 py-0.5 rounded bg-purple-100 text-purple-700 flex items-center gap-0.5">
                        <Mic className="size-3" /> Meeting Transcript
                    </span>
                    <span className="text-xs text-gray-400">
                        {new Date((doc.metadata?.meetingDate as string | undefined) ?? doc.created_at).toLocaleDateString()}
                    </span>
                    <span className="text-xs text-blue-500 flex items-center gap-0.5">
                        <Eye className="size-3" /> View
                    </span>
                </div>
                {/* Tag pills — assign to a category from the shared tag set */}
                <div className="flex items-center gap-1.5 flex-wrap mt-0.5" onClick={(e) => e.stopPropagation()}>
                    {doc.tags.map((tag) => (
                        <TagPill
                            key={tag.id}
                            tag={tag}
                            onRemove={() => removeDocTagMutation.mutate({ docId: doc.id, tagId: tag.id })}
                        />
                    ))}
                    <AddTagDropdown
                        docId={doc.id}
                        allTags={allTags}
                        docTagIds={doc.tags.map((t) => t.id)}
                        onAdd={(tagId) => addDocTagMutation.mutate({ docId: doc.id, tagId })}
                    />
                </div>
            </button>
            <div className="flex items-center gap-1 shrink-0 ml-2 mt-1">
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
                        onClick={() => setShowNewTagDialog(true)}
                        className="flex items-center gap-1"
                    >
                        <Tag className="size-4" />
                        New Category
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
                            {/* Tag picker for new document */}
                            {allTags.length > 0 && (
                                <div className="flex flex-col gap-1.5">
                                    <span className="text-xs text-gray-500 font-medium">Tags (optional)</span>
                                    <div className="flex flex-wrap gap-1.5">
                                        {allTags.map((tag) => {
                                            const selected = createTagIds.includes(tag.id);
                                            return (
                                                <button
                                                    key={tag.id}
                                                    type="button"
                                                    onClick={() => setCreateTagIds(
                                                        selected
                                                            ? createTagIds.filter((id) => id !== tag.id)
                                                            : [...createTagIds, tag.id]
                                                    )}
                                                    className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium transition-opacity ${selected ? "opacity-100" : "opacity-40 hover:opacity-70"}`}
                                                    style={{ backgroundColor: tag.color ?? "#6b7280", color: "white" }}
                                                >
                                                    {selected && <span>✓</span>}
                                                    {tag.name}
                                                </button>
                                            );
                                        })}
                                    </div>
                                </div>
                            )}
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

            {/* ── Document sections (grouped by tag) ───────────────────────── */}
            {isPending ? (
                <Card>
                    <CardContent className="flex flex-col items-center justify-center py-12">
                        <Loader2 className="size-8 text-blue-500 mb-3 animate-spin" />
                        <p className="text-sm text-gray-500">Loading…</p>
                    </CardContent>
                </Card>
            ) : (
                <>
                    {/* One card per tag section */}
                    {taggedSections.map(({ tag, docs }) => (
                        <Card key={tag.id}>
                            <CardHeader className="pb-2">
                                <div className="flex items-center justify-between">
                                    <div className="flex items-center gap-2">
                                        <span
                                            className="size-3 rounded-full shrink-0"
                                            style={{ backgroundColor: tag.color ?? "#6b7280" }}
                                        />
                                        {renamingTagId === tag.id ? (
                                            <InlineRename
                                                initialValue={tag.name}
                                                onCommit={(name) => renameTagMutation.mutate({ id: tag.id, name })}
                                                onCancel={() => setRenamingTagId(null)}
                                            />
                                        ) : (
                                            <CardTitle className="text-sm font-semibold">{tag.name}</CardTitle>
                                        )}
                                        <span className="text-xs text-gray-400">({docs.length})</span>
                                    </div>
                                    <div className="flex items-center gap-1">
                                        <Button
                                            variant="ghost"
                                            size="icon-sm"
                                            title="Rename category"
                                            onClick={() => setRenamingTagId(renamingTagId === tag.id ? null : tag.id)}
                                        >
                                            <Pencil className="size-3.5 text-gray-400" />
                                        </Button>
                                        <Button
                                            variant="ghost"
                                            size="icon-sm"
                                            title="Delete category"
                                            onClick={() => setTagToDelete(tag)}
                                            className="text-red-400 hover:text-red-600"
                                        >
                                            <Trash2 className="size-3.5" />
                                        </Button>
                                    </div>
                                </div>
                            </CardHeader>
                            <CardContent>
                                {docs.length === 0 ? (
                                    <p className="text-xs text-gray-400 py-2">No documents yet</p>
                                ) : (
                                    <div className="divide-y">
                                        {docs.map((doc) => <DocRow key={doc.id} doc={doc} />)}
                                    </div>
                                )}
                            </CardContent>
                        </Card>
                    ))}

                    {/* Uncategorized section */}
                    <Card>
                        <CardHeader className="pb-2">
                            <div className="flex items-center gap-2">
                                <BookOpen className="size-4 text-gray-400" />
                                <CardTitle className="text-sm font-semibold text-gray-500">Uncategorized</CardTitle>
                                <span className="text-xs text-gray-400">({untaggedDocs.length})</span>
                            </div>
                            <CardDescription className="text-xs">
                                Documents with no tags. The voice agent uses all active documents unless tag filtering is configured.
                            </CardDescription>
                        </CardHeader>
                        <CardContent>
                            {untaggedDocs.length === 0 && documents.length === 0 ? (
                                <div className="flex flex-col items-center justify-center py-8">
                                    <BookOpen className="size-8 text-gray-300 mb-2" />
                                    <p className="text-sm text-gray-500">No documents added yet</p>
                                    <p className="text-xs text-gray-400 mt-1">Use &quot;Add Document&quot; to upload information</p>
                                </div>
                            ) : untaggedDocs.length === 0 ? (
                                <p className="text-xs text-gray-400 py-2">All documents are tagged</p>
                            ) : (
                                <ScrollArea className="h-[400px]">
                                    <div className="divide-y pr-4">
                                        {untaggedDocs.map((doc) => <DocRow key={doc.id} doc={doc} />)}
                                    </div>
                                </ScrollArea>
                            )}
                        </CardContent>
                    </Card>
                </>
            )}

            {/* ── Section 2: Meeting Transcripts ──────────────────────────── */}
            <div className="mt-4">
                <div className="flex items-center gap-2 mb-3">
                    <Mic className="size-4 text-purple-500" />
                    <h2 className="text-base font-semibold text-gray-700">Meeting Transcripts</h2>
                    {!isTranscriptsPending && (
                        <span className="text-xs text-gray-400">({transcriptDocuments.length})</span>
                    )}
                </div>
                {isTranscriptsPending ? (
                    <Card>
                        <CardContent className="flex items-center justify-center py-8">
                            <Loader2 className="size-6 text-blue-500 animate-spin" />
                        </CardContent>
                    </Card>
                ) : transcriptDocuments.length === 0 ? (
                    <Card>
                        <CardContent className="flex flex-col items-center justify-center py-8">
                            <Mic className="size-8 text-gray-300 mb-2" />
                            <p className="text-sm text-gray-500">No meeting transcripts yet</p>
                            <p className="text-xs text-gray-400 mt-1">Transcripts from your meetings will appear here once ingested</p>
                        </CardContent>
                    </Card>
                ) : (
                    <>
                        {transcriptTaggedSections.map(({ tag, docs }) => (
                            <Card key={tag.id} className="mb-4">
                                <CardHeader className="pb-2">
                                    <div className="flex items-center gap-2">
                                        <span
                                            className="size-3 rounded-full shrink-0"
                                            style={{ backgroundColor: tag.color ?? "#6b7280" }}
                                        />
                                        <CardTitle className="text-sm font-semibold">{tag.name}</CardTitle>
                                        <span className="text-xs text-gray-400">({docs.length})</span>
                                    </div>
                                </CardHeader>
                                <CardContent>
                                    <div className="divide-y">
                                        {docs.map((doc) => <TranscriptRow key={doc.id} doc={doc} />)}
                                    </div>
                                </CardContent>
                            </Card>
                        ))}
                        {untaggedTranscripts.length > 0 && (
                            <Card>
                                <CardHeader className="pb-2">
                                    <div className="flex items-center gap-2">
                                        <Mic className="size-4 text-gray-400" />
                                        <CardTitle className="text-sm font-semibold text-gray-500">Uncategorized Transcripts</CardTitle>
                                        <span className="text-xs text-gray-400">({untaggedTranscripts.length})</span>
                                    </div>
                                    <CardDescription className="text-xs">
                                        Use the + tag button to assign these to a category so the voice agent can filter them.
                                    </CardDescription>
                                </CardHeader>
                                <CardContent>
                                    <div className="divide-y">
                                        {untaggedTranscripts.map((doc) => <TranscriptRow key={doc.id} doc={doc} />)}
                                    </div>
                                </CardContent>
                            </Card>
                        )}
                    </>
                )}
            </div>

            {/* ── New Category Dialog ───────────────────────────────────────── */}
            <Dialog open={showNewTagDialog} onOpenChange={(open) => { if (!open) { setShowNewTagDialog(false); setNewTagName(""); setNewTagColor("#3b82f6"); } }}>
                <DialogContent className="sm:max-w-sm">
                    <DialogHeader>
                        <DialogTitle className="flex items-center gap-2">
                            <Tag className="size-4" />
                            New Category
                        </DialogTitle>
                        <DialogDescription>Create a tag to group your knowledge base documents.</DialogDescription>
                    </DialogHeader>
                    <div className="flex flex-col gap-3">
                        <input
                            type="text"
                            placeholder="Category name (e.g. Investors)"
                            value={newTagName}
                            onChange={(e) => setNewTagName(e.target.value)}
                            onKeyDown={(e) => { if (e.key === "Enter" && newTagName.trim()) createTagMutation.mutate(); }}
                            className="w-full px-3 py-2 border rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                            autoFocus
                        />
                        <div className="flex items-center gap-3">
                            <label className="text-sm text-gray-600 shrink-0">Color</label>
                            <input
                                type="color"
                                value={newTagColor}
                                onChange={(e) => setNewTagColor(e.target.value)}
                                className="size-8 rounded cursor-pointer border border-gray-200"
                            />
                            <span
                                className="px-2 py-0.5 rounded-full text-xs text-white font-medium"
                                style={{ backgroundColor: newTagColor }}
                            >
                                {newTagName || "Preview"}
                            </span>
                        </div>
                    </div>
                    <DialogFooter>
                        <Button variant="outline" size="sm" onClick={() => setShowNewTagDialog(false)}>
                            Cancel
                        </Button>
                        <Button
                            size="sm"
                            disabled={!newTagName.trim() || createTagMutation.isPending}
                            onClick={() => createTagMutation.mutate()}
                            className="flex items-center gap-2"
                        >
                            {createTagMutation.isPending ? <><Loader2 className="size-4 animate-spin" />Creating…</> : "Create"}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {/* ── Delete Category Dialog ────────────────────────────────────── */}
            <Dialog open={!!tagToDelete} onOpenChange={(open) => { if (!open) setTagToDelete(null); }}>
                <DialogContent className="sm:max-w-sm">
                    <DialogHeader>
                        <DialogTitle className="text-red-600">Delete Category</DialogTitle>
                        <DialogDescription>
                            Delete &quot;{tagToDelete?.name}&quot;?{" "}
                            {(() => {
                                const count = tagToDelete ? (taggedSections.find((s) => s.tag.id === tagToDelete.id)?.docs.length ?? 0) : 0;
                                return count > 0
                                    ? `${count} document${count !== 1 ? "s" : ""} will become uncategorized.`
                                    : "No documents are tagged with this category.";
                            })()}
                            {" "}This cannot be undone.
                        </DialogDescription>
                    </DialogHeader>
                    <DialogFooter>
                        <Button variant="outline" size="sm" onClick={() => setTagToDelete(null)}>
                            Cancel
                        </Button>
                        <Button
                            variant="destructive"
                            size="sm"
                            disabled={deleteTagMutation.isPending}
                            onClick={() => tagToDelete && deleteTagMutation.mutate(tagToDelete.id)}
                            className="flex items-center gap-2"
                        >
                            {deleteTagMutation.isPending ? <><Loader2 className="size-4 animate-spin" />Deleting…</> : "Delete"}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

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
        </div>
    );
}

export default KnowledgeBase;
