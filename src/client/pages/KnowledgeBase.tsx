import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { Loader2, Plus, Trash2, BookOpen, Power, Pencil, Eye, Star } from "lucide-react";
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

const CATEGORIES = [
    { value: "company_docs", label: "Company Documents" },
    { value: "faq", label: "FAQ / Product Info" },
    { value: "crm", label: "CRM / Customer" },
    { value: "transcripts", label: "Meeting History" },
];

interface KBDocument {
    id: string;
    title: string;
    source_type: string;
    is_active: boolean;
    created_at: string;
    category: string;
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

function KnowledgeBase() {
    const queryClient = useQueryClient();

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

    // ── List query ────────────────────────────────────────────────────
    const { data, isPending } = useQuery<{ documents: KBDocument[] }>({
        queryKey: ["kb_documents"],
        queryFn: async () => {
            const res = await fetch("/api/kb");
            if (!res.ok) throw new Error(await res.text());
            return res.json();
        },
    });

    // ── Single document query (fires when dialog is open) ─────────────
    const {
        data: fullDoc,
        isPending: isLoadingDoc,
    } = useQuery<KBDocumentFull>({
        queryKey: ["kb_document", selectedDocId],
        queryFn: async () => {
            const res = await fetch(`/api/kb/${selectedDocId}`);
            if (!res.ok) throw new Error(await res.text());
            return res.json();
        },
        enabled: !!selectedDocId,
    });

    // ── Create mutation ───────────────────────────────────────────────
    const createMutation = useMutation({
        mutationFn: async () => {
            const res = await fetch("/api/kb", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ title, category, content }),
            });
            if (!res.ok) throw new Error(await res.text());
            return res.json();
        },
        onSuccess: (resData) => {
            toast.success(`"${title}" added (${resData.chunks} chunks)`);
            setTitle("");
            setContent("");
            setShowForm(false);
            void queryClient.invalidateQueries({ queryKey: ["kb_documents"] });
        },
        onError: (err: Error) => {
            toast.error(err.message);
        },
    });

    // ── Update mutation ───────────────────────────────────────────────
    const updateMutation = useMutation({
        mutationFn: async () => {
            if (!selectedDocId) throw new Error("No document selected");
            const res = await fetch(`/api/kb/${selectedDocId}`, {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    title: editTitle,
                    category: editCategory,
                    content: editContent,
                }),
            });
            if (!res.ok) throw new Error(await res.text());
            return res.json();
        },
        onSuccess: (resData) => {
            toast.success(`Updated (${resData.chunks} chunks)`);
            setIsEditing(false);
            void queryClient.invalidateQueries({ queryKey: ["kb_documents"] });
            void queryClient.invalidateQueries({ queryKey: ["kb_document", selectedDocId] });
        },
        onError: (err: Error) => {
            toast.error(err.message);
        },
    });

    // ── Delete mutation ───────────────────────────────────────────────
    const deleteMutation = useMutation({
        mutationFn: async (id: string) => {
            const res = await fetch(`/api/kb?id=${id}`, { method: "DELETE" });
            if (!res.ok) throw new Error(await res.text());
        },
        onSuccess: () => {
            toast.success("Document deleted");
            void queryClient.invalidateQueries({ queryKey: ["kb_documents"] });
        },
        onError: (err: Error) => toast.error(err.message),
    });

    // ── Toggle mutation ───────────────────────────────────────────────
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
        },
        onError: (err: Error) => toast.error(err.message),
    });

    // ── Bot settings query (to know which doc is the default) ─────────
    const { data: botSettings } = useQuery<{ active_kb_id: string | null }>({
        queryKey: ["bot_settings"],
        queryFn: async () => {
            const res = await fetch("/api/bot-settings");
            if (!res.ok) throw new Error(await res.text());
            return res.json();
        },
    });

    // ── Set default mutation ──────────────────────────────────────────
    const setDefaultMutation = useMutation({
        mutationFn: async (id: string) => {
            const res = await fetch("/api/bot-settings", {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ active_kb_id: id }),
            });
            if (!res.ok) throw new Error(await res.text());
        },
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: ["bot_settings"] });
            toast.success("Default KB updated");
        },
        onError: (err: Error) => toast.error(err.message),
    });

    const documents = data?.documents ?? [];
    const activeKbId = botSettings?.active_kb_id ?? null;

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

    return (
        <div className="flex flex-col gap-4 max-w-3xl mx-auto">
            <div className="flex items-center justify-between">
                <h1 className="text-lg font-semibold">Knowledge Base</h1>
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
                                    <option key={cat.value} value={cat.value}>
                                        {cat.label}
                                    </option>
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
                                <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={() => setShowForm(false)}
                                >
                                    Cancel
                                </Button>
                                <Button
                                    size="sm"
                                    disabled={!title.trim() || !content.trim() || createMutation.isPending}
                                    onClick={() => createMutation.mutate()}
                                    className="flex items-center gap-2"
                                >
                                    {createMutation.isPending ? (
                                        <>
                                            <Loader2 className="size-4 animate-spin" />
                                            Saving...
                                        </>
                                    ) : (
                                        "Save"
                                    )}
                                </Button>
                            </div>
                        </div>
                    </CardContent>
                </Card>
            )}

            {/* ── Document List ─────────────────────────────────────────────── */}
            <Card>
                <CardHeader className="pb-3">
                    <CardTitle className="text-base flex items-center gap-2">
                        <BookOpen className="size-4" />
                        Documents
                    </CardTitle>
                    <CardDescription>
                        The default Knowledge Base is used by Voice Agent for all meetings unless overridden per meeting.
                    </CardDescription>
                </CardHeader>
                <CardContent>
                    {isPending ? (
                        <div className="flex flex-col items-center justify-center py-12">
                            <Loader2 className="size-8 text-blue-500 mb-3 animate-spin" />
                            <p className="text-sm text-gray-500">Loading…</p>
                        </div>
                    ) : documents.length === 0 ? (
                        <div className="flex flex-col items-center justify-center py-12">
                            <BookOpen className="size-8 text-gray-300 mb-2" />
                            <p className="text-sm text-gray-500">
                                No documents added yet
                            </p>
                            <p className="text-xs text-gray-400 mt-1">
                                Use &quot;Add Document&quot; to upload information
                            </p>
                        </div>
                    ) : (
                        <ScrollArea className="h-[400px]">
                            <div className="divide-y pr-4">
                                {documents.map((doc) => (
                                    <div
                                        key={doc.id}
                                        className={`flex items-center justify-between py-3 ${!doc.is_active ? "opacity-50" : ""
                                            }`}
                                    >
                                        <button
                                            type="button"
                                            onClick={() => handleOpenDocument(doc.id)}
                                            className="flex flex-col gap-0.5 min-w-0 flex-1 text-left hover:bg-gray-50 -mx-2 px-2 py-1 rounded-md transition-colors cursor-pointer"
                                        >
                                            <span className="text-sm font-medium text-gray-800 truncate">
                                                {doc.title}
                                            </span>
                                            <div className="flex items-center gap-2">
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
                                        </button>
                                        <div className="flex items-center gap-1 shrink-0 ml-2">
                                            {/* Default star */}
                                            <Button
                                                variant="ghost"
                                                size="icon-sm"
                                                title={activeKbId === doc.id ? "Default KB" : "Set as default"}
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    if (activeKbId !== doc.id) {
                                                        setDefaultMutation.mutate(doc.id);
                                                    }
                                                }}
                                                disabled={setDefaultMutation.isPending}
                                            >
                                                <Star
                                                    className={`size-4 ${activeKbId === doc.id
                                                            ? "fill-yellow-400 text-yellow-400"
                                                            : "text-gray-300 hover:text-yellow-400"
                                                        }`}
                                                />
                                            </Button>
                                            {activeKbId === doc.id && (
                                                <span className="text-xs px-1.5 py-0.5 rounded-full bg-yellow-50 text-yellow-700 font-medium">
                                                    Default
                                                </span>
                                            )}
                                            <Button
                                                variant="ghost"
                                                size="icon-sm"
                                                title={doc.is_active ? "Deactivate" : "Activate"}
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    toggleMutation.mutate({
                                                        id: doc.id,
                                                        is_active: !doc.is_active,
                                                    });
                                                }}
                                            >
                                                <Power
                                                    className={`size-4 ${doc.is_active
                                                            ? "text-green-600"
                                                            : "text-gray-400"
                                                        }`}
                                                />
                                            </Button>
                                            <Button
                                                variant="ghost"
                                                size="icon-sm"
                                                title="Delete"
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    if (confirm(`"${doc.title}" will be deleted. Are you sure?`))
                                                        deleteMutation.mutate(doc.id);
                                                }}
                                                className="text-red-500 hover:text-red-700"
                                            >
                                                <Trash2 className="size-4" />
                                            </Button>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </ScrollArea>
                    )}
                </CardContent>
            </Card>

            {/* ── View / Edit Dialog ───────────────────────────────────────── */}
            <Dialog open={!!selectedDocId} onOpenChange={(open) => { if (!open) handleCloseDialog(); }}>
                <DialogContent className="sm:max-w-2xl max-h-[85vh] overflow-y-auto">
                    {isLoadingDoc ? (
                        <div className="flex flex-col items-center justify-center py-12">
                            <Loader2 className="size-8 text-blue-500 mb-3 animate-spin" />
                            <p className="text-sm text-gray-500">Loading document…</p>
                        </div>
                    ) : !fullDoc ? (
                        <div className="py-12 text-center text-sm text-red-500">
                            Document not found.
                        </div>
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
                                        <option key={cat.value} value={cat.value}>
                                            {cat.label}
                                        </option>
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
                                <Button
                                    type="button"
                                    variant="outline"
                                    size="sm"
                                    onClick={handleCancelEditing}
                                    disabled={updateMutation.isPending}
                                >
                                    Cancel
                                </Button>
                                <Button
                                    type="button"
                                    size="sm"
                                    disabled={
                                        !editTitle.trim() ||
                                        !editContent.trim() ||
                                        updateMutation.isPending
                                    }
                                    onClick={() => updateMutation.mutate()}
                                    className="flex items-center gap-2"
                                >
                                    {updateMutation.isPending ? (
                                        <>
                                            <Loader2 className="size-4 animate-spin" />
                                            Saving...
                                        </>
                                    ) : (
                                        "Save"
                                    )}
                                </Button>
                            </DialogFooter>
                        </>
                    ) : (
                        /* ── VIEW MODE ─────────────────────────────────────────── */
                        <>
                            <DialogHeader>
                                <DialogTitle className="flex items-center gap-2">
                                    <BookOpen className="size-4" />
                                    {fullDoc.title}
                                </DialogTitle>
                                <DialogDescription className="flex items-center gap-2">
                                    <span className="text-xs px-1.5 py-0.5 rounded bg-gray-100 text-gray-600">
                                        {CATEGORIES.find((c) => c.value === fullDoc.category)?.label ?? fullDoc.category}
                                    </span>
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
                                <Button
                                    type="button"
                                    variant="outline"
                                    size="sm"
                                    onClick={handleCloseDialog}
                                >
                                    Close
                                </Button>
                                <Button
                                    type="button"
                                    size="sm"
                                    onClick={handleStartEditing}
                                    className="flex items-center gap-2"
                                >
                                    <Pencil className="size-4" />
                                    Edit
                                </Button>
                            </DialogFooter>
                        </>
                    )}
                </DialogContent>
            </Dialog>
        </div>
    );
}

export default KnowledgeBase;
