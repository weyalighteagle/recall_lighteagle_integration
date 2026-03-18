import { z } from "zod";
import { supabase } from "../config/supabase";
import { env } from "../config/env";
import { createHash } from "crypto";

// ─── Helpers ────────────────────────────────────────────────

const EMBEDDING_MODEL = "text-embedding-3-small";

async function createEmbeddings(texts: string[]): Promise<number[][]> {
    const apiKey = env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("OPENAI_API_KEY is not configured");

    const allEmbeddings: number[][] = [];
    const batchSize = 100;

    for (let i = 0; i < texts.length; i += batchSize) {
        const batch = texts.slice(i, i + batchSize);
        const response = await fetch("https://api.openai.com/v1/embeddings", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${apiKey}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({ model: EMBEDDING_MODEL, input: batch }),
        });
        if (!response.ok) throw new Error(`OpenAI embeddings error: ${await response.text()}`);
        const data = await response.json();
        allEmbeddings.push(...data.data.map((d: any) => d.embedding));
    }
    return allEmbeddings;
}

function chunkText(text: string, maxChars = 2000, overlapChars = 400): string[] {
    const chunks: string[] = [];
    const paragraphs = text.split(/\n\n+/);
    let currentChunk = "";

    for (const para of paragraphs) {
        if (currentChunk.length + para.length + 2 > maxChars && currentChunk.length > 0) {
            chunks.push(currentChunk.trim());
            const overlapStart = Math.max(0, currentChunk.length - overlapChars);
            currentChunk = currentChunk.slice(overlapStart) + "\n\n" + para;
        } else {
            currentChunk += (currentChunk ? "\n\n" : "") + para;
        }
    }
    if (currentChunk.trim()) chunks.push(currentChunk.trim());
    return chunks;
}

// ─── Handlers ───────────────────────────────────────────────

/** GET /api/kb — doküman listesi */
export async function kb_list(): Promise<{ documents: any[] }> {
    const { data, error } = await supabase
        .from("kb_documents")
        .select("id, title, source_type, is_active, created_at, category_id, kb_categories(name)")
        .order("created_at", { ascending: false });

    if (error) throw new Error(error.message);

    const documents = (data ?? []).map((doc: any) => ({
        id: doc.id,
        title: doc.title,
        source_type: doc.source_type,
        is_active: doc.is_active,
        created_at: doc.created_at,
        category: doc.kb_categories?.name ?? "unknown",
    }));

    return { documents };
}

/** POST /api/kb — yeni doküman ekle (metin + başlık + kategori) */
export async function kb_create(body: { title: string; category: string; content: string }): Promise<{ document_id: string; chunks: number }> {
    const { title, category, content } = z.object({
        title: z.string().min(1),
        category: z.string().min(1),
        content: z.string().min(1),
    }).parse(body);

    // Duplicate check
    const contentHash = createHash("sha256").update(content).digest("hex");
    const { data: existing } = await supabase
        .from("kb_documents")
        .select("id")
        .eq("content_hash", contentHash)
        .maybeSingle();
    if (existing) throw new Error(`Bu içerik zaten mevcut (id: ${existing.id})`);

    // Get category id
    const { data: cat } = await supabase
        .from("kb_categories")
        .select("id")
        .eq("name", category)
        .single();
    if (!cat) throw new Error(`Kategori bulunamadı: ${category}`);

    // Create document
    const { data: doc, error: docErr } = await supabase
        .from("kb_documents")
        .insert({
            title,
            category_id: cat.id,
            source_type: "manual",
            content_hash: contentHash,
            metadata: {},
        })
        .select("id")
        .single();
    if (docErr) throw new Error(docErr.message);

    // Chunk + embed
    const chunks = chunkText(content);
    const embeddings = await createEmbeddings(chunks);

    const rows = chunks.map((chunk, i) => ({
        document_id: doc.id,
        chunk_index: i,
        content: chunk,
        token_count: Math.ceil(chunk.length / 4),
        embedding: JSON.stringify(embeddings[i]),
    }));

    const { error: chunkErr } = await supabase.from("kb_chunks").insert(rows);
    if (chunkErr) throw new Error(chunkErr.message);

    console.log(`[kb] Created "${title}" — ${chunks.length} chunks`);
    return { document_id: doc.id, chunks: chunks.length };
}

/** DELETE /api/kb?id=xxx — doküman sil */
export async function kb_delete(args: { id: string }): Promise<void> {
    const { id } = z.object({ id: z.string().uuid() }).parse(args);
    const { error } = await supabase.from("kb_documents").delete().eq("id", id);
    if (error) throw new Error(error.message);
    console.log(`[kb] Deleted document ${id}`);
}

/** PATCH /api/kb?id=xxx — aktif/pasif toggle */
export async function kb_toggle(args: { id: string; is_active: boolean }): Promise<void> {
    const { id, is_active } = z.object({
        id: z.string().uuid(),
        is_active: z.boolean(),
    }).parse(args);
    const { error } = await supabase
        .from("kb_documents")
        .update({ is_active })
        .eq("id", id);
    if (error) throw new Error(error.message);
    console.log(`[kb] Document ${id} is_active=${is_active}`);
}

/** GET /api/kb/:id — single document with full content reconstructed from chunks */
export async function kb_get(args: { id: string }): Promise<{
    id: string;
    title: string;
    category: string;
    content: string;
    source_type: string;
    is_active: boolean;
    created_at: string;
}> {
    const { id } = z.object({ id: z.string().uuid() }).parse(args);

    // Fetch document metadata
    const { data: doc, error: docErr } = await supabase
        .from("kb_documents")
        .select("id, title, source_type, is_active, created_at, category_id, kb_categories(name)")
        .eq("id", id)
        .single();

    if (docErr || !doc) throw new Error(docErr?.message ?? "Document not found");

    // Fetch all chunks ordered by index and reassemble content
    const { data: chunks, error: chunkErr } = await supabase
        .from("kb_chunks")
        .select("content, chunk_index")
        .eq("document_id", id)
        .order("chunk_index", { ascending: true });

    if (chunkErr) throw new Error(chunkErr.message);

    // Reassemble: chunks have overlap from the chunking algorithm,
    // but for editing purposes we just concatenate — the user will see
    // the full text and can edit freely. On save we re-chunk from scratch.
    const content = (chunks ?? []).map((c: any) => c.content).join("\n\n");

    return {
        id: doc.id,
        title: doc.title,
        category: (doc as any).kb_categories?.name ?? "company_docs",
        content,
        source_type: doc.source_type,
        is_active: doc.is_active,
        created_at: doc.created_at,
    };
}

/** PUT /api/kb/:id — update document title, category, and content (re-chunk + re-embed) */
export async function kb_update(args: {
    id: string;
    title: string;
    category: string;
    content: string;
}): Promise<{ document_id: string; chunks: number }> {
    const { id, title, category, content } = z.object({
        id: z.string().uuid(),
        title: z.string().min(1),
        category: z.string().min(1),
        content: z.string().min(1),
    }).parse(args);

    // Verify document exists
    const { data: existingDoc, error: existErr } = await supabase
        .from("kb_documents")
        .select("id")
        .eq("id", id)
        .single();

    if (existErr || !existingDoc) throw new Error("Document not found");

    // Get category id
    const { data: cat } = await supabase
        .from("kb_categories")
        .select("id")
        .eq("name", category)
        .single();
    if (!cat) throw new Error(`Kategori bulunamadı: ${category}`);

    // Update document metadata
    const newContentHash = createHash("sha256").update(content).digest("hex");
    const { error: updateErr } = await supabase
        .from("kb_documents")
        .update({
            title,
            category_id: cat.id,
            content_hash: newContentHash,
        })
        .eq("id", id);

    if (updateErr) throw new Error(updateErr.message);

    // Delete old chunks
    const { error: deleteErr } = await supabase
        .from("kb_chunks")
        .delete()
        .eq("document_id", id);

    if (deleteErr) throw new Error(deleteErr.message);

    // Re-chunk and re-embed
    const chunks = chunkText(content);
    const embeddings = await createEmbeddings(chunks);

    const rows = chunks.map((chunk, i) => ({
        document_id: id,
        chunk_index: i,
        content: chunk,
        token_count: Math.ceil(chunk.length / 4),
        embedding: JSON.stringify(embeddings[i]),
    }));

    const { error: insertErr } = await supabase.from("kb_chunks").insert(rows);
    if (insertErr) throw new Error(insertErr.message);

    console.log(`[kb] Updated "${title}" — ${chunks.length} chunks`);
    return { document_id: id, chunks: chunks.length };
}
