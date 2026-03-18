import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { Loader2, Plus, Trash2, BookOpen, Power, Pencil, Eye } from "lucide-react";
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
    { value: "company_docs", label: "Şirket Dokümanları" },
    { value: "faq", label: "SSS / Ürün Bilgisi" },
    { value: "crm", label: "CRM / Müşteri" },
    { value: "transcripts", label: "Toplantı Geçmişi" },
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
            toast.success(`"${title}" eklendi (${resData.chunks} parça)`);
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
            toast.success(`Güncellendi (${resData.chunks} parça)`);
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
            toast.success("Doküman silindi");
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

    const documents = data?.documents ?? [];

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
                    Doküman Ekle
                </Button>
            </div>

            {/* ── Add Document Form ────────────────────────────────────────── */}
            {showForm && (
                <Card>
                    <CardHeader className="pb-3">
                        <CardTitle className="text-base">Yeni Doküman</CardTitle>
                        <CardDescription>
                            Metin yapıştır, başlık ve kategori seç. Bot toplantıda bu bilgileri kullanacak.
                        </CardDescription>
                    </CardHeader>
                    <CardContent>
                        <div className="flex flex-col gap-3">
                            <input
                                type="text"
                                placeholder="Başlık (ör: Fiyat Listesi)"
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
                                placeholder="İçerik metni buraya yapıştır..."
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
                                    İptal
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
                                            Kaydediliyor...
                                        </>
                                    ) : (
                                        "Kaydet"
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
                        Dokümanlar
                    </CardTitle>
                    <CardDescription>
                        {documents.length} doküman yüklü
                    </CardDescription>
                </CardHeader>
                <CardContent>
                    {isPending ? (
                        <div className="flex flex-col items-center justify-center py-12">
                            <Loader2 className="size-8 text-blue-500 mb-3 animate-spin" />
                            <p className="text-sm text-gray-500">Yükleniyor…</p>
                        </div>
                    ) : documents.length === 0 ? (
                        <div className="flex flex-col items-center justify-center py-12">
                            <BookOpen className="size-8 text-gray-300 mb-2" />
                            <p className="text-sm text-gray-500">
                                Henüz doküman eklenmemiş
                            </p>
                            <p className="text-xs text-gray-400 mt-1">
                                "Doküman Ekle" butonuyla bilgi yükleyin
                            </p>
                        </div>
                    ) : (
                        <ScrollArea className="h-[400px]">
                            <div className="divide-y pr-4">
                                {documents.map((doc) => (
                                    <div
                                        key={doc.id}
                                        className={`flex items-center justify-between py-3 ${
                                            !doc.is_active ? "opacity-50" : ""
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
                                                    <Eye className="size-3" /> Görüntüle
                                                </span>
                                            </div>
                                        </button>
                                        <div className="flex items-center gap-1 shrink-0 ml-2">
                                            <Button
                                                variant="ghost"
                                                size="icon-sm"
                                                title={doc.is_active ? "Pasife al" : "Aktif et"}
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    toggleMutation.mutate({
                                                        id: doc.id,
                                                        is_active: !doc.is_active,
                                                    });
                                                }}
                                            >
                                                <Power
                                                    className={`size-4 ${
                                                        doc.is_active
                                                            ? "text-green-600"
                                                            : "text-gray-400"
                                                    }`}
                                                />
                                            </Button>
                                            <Button
                                                variant="ghost"
                                                size="icon-sm"
                                                title="Sil"
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    if (confirm(`"${doc.title}" silinecek. Emin misin?`))
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
                            <p className="text-sm text-gray-500">Doküman yükleniyor…</p>
                        </div>
                    ) : !fullDoc ? (
                        <div className="py-12 text-center text-sm text-red-500">
                            Doküman bulunamadı.
                        </div>
                    ) : isEditing ? (
                        /* ── EDIT MODE ─────────────────────────────────────────── */
                        <>
                            <DialogHeader>
                                <DialogTitle className="flex items-center gap-2">
                                    <Pencil className="size-4" />
                                    Doküman Düzenle
                                </DialogTitle>
                                <DialogDescription>
                                    İçeriği düzenle ve kaydet. Kaydettiğinde chunk&apos;lar ve embedding&apos;ler yeniden oluşturulur.
                                </DialogDescription>
                            </DialogHeader>
                            <div className="flex flex-col gap-3">
                                <input
                                    type="text"
                                    value={editTitle}
                                    onChange={(e) => setEditTitle(e.target.value)}
                                    placeholder="Başlık"
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
                                    İptal
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
                                            Kaydediliyor...
                                        </>
                                    ) : (
                                        "Kaydet"
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
                                        {fullDoc.is_active ? "Aktif" : "Pasif"}
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
                                    Kapat
                                </Button>
                                <Button
                                    type="button"
                                    size="sm"
                                    onClick={handleStartEditing}
                                    className="flex items-center gap-2"
                                >
                                    <Pencil className="size-4" />
                                    Düzenle
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
