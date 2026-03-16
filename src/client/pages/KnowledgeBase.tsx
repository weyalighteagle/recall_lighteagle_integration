import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { Loader2, Plus, Trash2, BookOpen, Power } from "lucide-react";
import { Button } from "../components/ui/Button";
import {
    Card,
    CardContent,
    CardHeader,
    CardTitle,
    CardDescription,
} from "../components/ui/Card";
import { ScrollArea } from "../components/ui/ScrollArea";

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

function KnowledgeBase() {
    const queryClient = useQueryClient();
    const [showForm, setShowForm] = useState(false);
    const [title, setTitle] = useState("");
    const [category, setCategory] = useState("faq");
    const [content, setContent] = useState("");

    const { data, isPending } = useQuery<{ documents: KBDocument[] }>({
        queryKey: ["kb_documents"],
        queryFn: async () => {
            const res = await fetch("/api/kb");
            if (!res.ok) throw new Error(await res.text());
            return res.json();
        },
    });

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
        onSuccess: (data) => {
            toast.success(`"${title}" eklendi (${data.chunks} parça)`);
            setTitle("");
            setContent("");
            setShowForm(false);
            void queryClient.invalidateQueries({ queryKey: ["kb_documents"] });
        },
        onError: (err: Error) => {
            toast.error(err.message);
        },
    });

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

            {/* Add Document Form */}
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

            {/* Document List */}
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
                                        <div className="flex flex-col gap-0.5 min-w-0 flex-1">
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
                                            </div>
                                        </div>
                                        <div className="flex items-center gap-1 shrink-0">
                                            <Button
                                                variant="ghost"
                                                size="icon-sm"
                                                title={doc.is_active ? "Pasife al" : "Aktif et"}
                                                onClick={() =>
                                                    toggleMutation.mutate({
                                                        id: doc.id,
                                                        is_active: !doc.is_active,
                                                    })
                                                }
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
                                                onClick={() => {
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
        </div>
    );
}

export default KnowledgeBase;
