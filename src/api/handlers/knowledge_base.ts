import { z } from "zod";
import { supabase } from "../config/supabase";
import { env } from "../config/env";
import { createHash } from "crypto";

// ─── Helpers ────────────────────────────────────────────────

const EMBEDDING_MODEL = "text-embedding-3-small";

export async function createEmbeddings(texts: string[]): Promise<number[][]> {
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
        allEmbeddings.push(...data.data.map((d: any) => d.embedding)); // eslint-disable-line @typescript-eslint/no-explicit-any
    }
    return allEmbeddings;
}

export function chunkText(text: string, maxChars = 1000, overlapChars = 200): string[] {
    const chunks: string[] = [];
    // Split on single or double newlines — transcripts use single \n between utterances
    const paragraphs = text.split(/\n+/);
    let currentChunk = "";

    for (const para of paragraphs) {
        // If a single line is longer than maxChars, split it at character boundaries
        if (para.length > maxChars) {
            if (currentChunk.trim()) {
                chunks.push(currentChunk.trim());
                currentChunk = "";
            }
            let pos = 0;
            while (pos < para.length) {
                chunks.push(para.slice(pos, pos + maxChars).trim());
                pos += maxChars - overlapChars;
            }
            continue;
        }

        if (currentChunk.length + para.length + 1 > maxChars && currentChunk.length > 0) {
            chunks.push(currentChunk.trim());
            const overlapStart = Math.max(0, currentChunk.length - overlapChars);
            currentChunk = currentChunk.slice(overlapStart) + "\n" + para;
        } else {
            currentChunk += (currentChunk ? "\n" : "") + para;
        }
    }
    if (currentChunk.trim()) chunks.push(currentChunk.trim());
    return chunks;
}

// Hardcoded — avoids an async Supabase round-trip on every tag operation.
// Source: SELECT id FROM orgs WHERE name = 'Light Eagle' on the weya-recallai project.
const LIGHT_EAGLE_ORG_ID = "d6d7b0e1-cf72-4c17-b228-433571e8efbb";

// After document tag changes, keep kb_chunks.tag_ids in sync for the Phase 5 RPC.
async function syncChunkTagIds(documentId: string): Promise<void> {
    const { data: tagLinks } = await supabase
        .from("kb_document_tags")
        .select("tag_id")
        .eq("document_id", documentId);

    const tag_ids = (tagLinks ?? []).map((t: { tag_id: string }) => t.tag_id);

    const { error } = await supabase
        .from("kb_chunks")
        .update({ tag_ids })
        .eq("document_id", documentId);

    if (error) throw new Error(`syncChunkTagIds: ${error.message}`);
}

function slugify(name: string): string {
    return name
        .toLowerCase()
        .replace(/\s+/g, "-")
        .replace(/[^a-z0-9-]/g, "")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "");
}

// ─── Types ───────────────────────────────────────────────────

export interface KbTag {
    id: string;
    name: string;
    slug: string;
    color: string | null;
    created_by: string | null;
    created_at: string;
}

interface DocTag {
    id: string;
    name: string;
    color: string | null;
}

// ─── KB Document Handlers ────────────────────────────────────

/** GET /api/kb — doküman listesi with tags per document */
export async function kb_list(): Promise<{ documents: Array<{
    id: string;
    title: string;
    source_type: string;
    is_active: boolean;
    created_at: string;
    category: string;
    tags: DocTag[];
}> }> {
    // Supabase returns nested relations as any — we type them explicitly below
    const { data, error } = await supabase
        .from("kb_documents")
        .select(`
            id, title, source_type, is_active, created_at,
            kb_categories(name),
            kb_document_tags(tag_id, kb_tags(id, name, color))
        `)
        .neq("source_type", "transcript")
        .order("created_at", { ascending: false });

    if (error) throw new Error(error.message);

    const documents = (data ?? []).map((doc: any) => ({ // eslint-disable-line @typescript-eslint/no-explicit-any
        id: doc.id as string,
        title: doc.title as string,
        source_type: doc.source_type as string,
        is_active: doc.is_active as boolean,
        created_at: doc.created_at as string,
        category: (doc.kb_categories?.name ?? "unknown") as string,
        tags: ((doc.kb_document_tags ?? []) as Array<{ tag_id: string; kb_tags: { id: string; name: string; color: string | null } | null }>)
            .map((dt) => dt.kb_tags)
            .filter((t): t is { id: string; name: string; color: string | null } => t !== null),
    }));

    return { documents };
}

/** POST /api/kb — yeni doküman ekle (metin + başlık + kategori + isteğe bağlı tag_ids) */
export async function kb_create(body: {
    title: string;
    category: string;
    content: string;
    tag_ids?: string[];
}): Promise<{ document_id: string; chunks: number }> {
    const { title, category, content, tag_ids } = z.object({
        title: z.string().min(1),
        category: z.string().min(1),
        content: z.string().min(1),
        tag_ids: z.array(z.string().uuid()).optional(),
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

    const orgId = LIGHT_EAGLE_ORG_ID;

    // Create document
    const { data: doc, error: docErr } = await supabase
        .from("kb_documents")
        .insert({
            title,
            category_id: cat.id,
            source_type: "manual",
            content_hash: contentHash,
            metadata: {},
            org_id: orgId,
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
        org_id: orgId,
    }));

    const { error: chunkErr } = await supabase.from("kb_chunks").insert(rows);
    if (chunkErr) throw new Error(chunkErr.message);

    // Link tags if provided
    if (tag_ids && tag_ids.length > 0) {
        const tagRows = tag_ids.map((tag_id) => ({ document_id: doc.id, tag_id }));
        const { error: tagErr } = await supabase.from("kb_document_tags").insert(tagRows);
        if (tagErr) throw new Error(tagErr.message);
        await syncChunkTagIds(doc.id);
    }

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

    // Sync chunk is_active to match document
    const { error: chunkErr } = await supabase
        .from("kb_chunks")
        .update({ is_active })
        .eq("document_id", id);
    if (chunkErr) throw new Error(chunkErr.message);

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

    const { data: doc, error: docErr } = await supabase
        .from("kb_documents")
        .select("id, title, source_type, is_active, created_at, category_id, kb_categories(name)")
        .eq("id", id)
        .single();

    if (docErr || !doc) throw new Error(docErr?.message ?? "Document not found");

    const { data: chunks, error: chunkErr } = await supabase
        .from("kb_chunks")
        .select("content, chunk_index")
        .eq("document_id", id)
        .order("chunk_index", { ascending: true });

    if (chunkErr) throw new Error(chunkErr.message);

    // Reassemble: chunks have overlap from the chunking algorithm,
    // but for editing purposes we just concatenate — the user will see
    // the full text and can edit freely. On save we re-chunk from scratch.
    const content = (chunks ?? []).map((c: any) => c.content).join("\n\n"); // eslint-disable-line @typescript-eslint/no-explicit-any

    return {
        id: doc.id,
        title: doc.title,
        category: (doc as any).kb_categories?.name ?? "company_docs", // eslint-disable-line @typescript-eslint/no-explicit-any
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

    const { data: existingDoc, error: existErr } = await supabase
        .from("kb_documents")
        .select("id")
        .eq("id", id)
        .single();

    if (existErr || !existingDoc) throw new Error("Document not found");

    const { data: cat } = await supabase
        .from("kb_categories")
        .select("id")
        .eq("name", category)
        .single();
    if (!cat) throw new Error(`Kategori bulunamadı: ${category}`);

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

    const { error: deleteErr } = await supabase
        .from("kb_chunks")
        .delete()
        .eq("document_id", id);

    if (deleteErr) throw new Error(deleteErr.message);

    const chunks = chunkText(content);
    const embeddings = await createEmbeddings(chunks);

    // Re-fetch current tag_ids so the new chunks start with the right tag_ids
    const { data: tagLinks } = await supabase
        .from("kb_document_tags")
        .select("tag_id")
        .eq("document_id", id);
    const tag_ids = (tagLinks ?? []).map((t: { tag_id: string }) => t.tag_id);

    const rows = chunks.map((chunk, i) => ({
        document_id: id,
        chunk_index: i,
        content: chunk,
        token_count: Math.ceil(chunk.length / 4),
        embedding: JSON.stringify(embeddings[i]),
        tag_ids,
    }));

    const { error: insertErr } = await supabase.from("kb_chunks").insert(rows);
    if (insertErr) throw new Error(insertErr.message);

    console.log(`[kb] Updated "${title}" — ${chunks.length} chunks`);
    return { document_id: id, chunks: chunks.length };
}

// ─── Tag Handlers ────────────────────────────────────────────

/** GET /api/kb/tags — list all tags for the org */
export async function tag_list(): Promise<{ tags: KbTag[] }> {
    const orgId = LIGHT_EAGLE_ORG_ID;
    const { data, error } = await supabase
        .from("kb_tags")
        .select("id, name, slug, color, created_by, created_at")
        .eq("org_id", orgId)
        .order("created_at", { ascending: true });

    if (error) throw new Error(error.message);
    return { tags: (data ?? []) as KbTag[] };
}

/** POST /api/kb/tags — create a new tag */
export async function tag_create(
    body: { name: string; color?: string },
    userEmail: string,
): Promise<KbTag> {
    const { name, color } = z.object({
        name: z.string().min(1).max(64),
        color: z.string().optional(),
    }).parse(body);

    const orgId = LIGHT_EAGLE_ORG_ID;
    const slug = slugify(name);

    console.log("[tag_create] inserting tag:", { name, slug, color: color ?? null, org_id: LIGHT_EAGLE_ORG_ID });
    const { data, error } = await supabase
        .from("kb_tags")
        .insert({
            org_id: orgId,
            name,
            slug,
            color: color ?? null,
            created_by: userEmail,
        })
        .select("id, name, slug, color, created_by, created_at")
        .single();

    if (error) {
        console.error("[tag_create] supabase error:", error);
        if (error.code === "23505") throw new Error(`A tag named "${name}" already exists`);
        throw new Error(error.message);
    }

    console.log("[tag_create] result:", data);
    return data as KbTag;
}

/** PATCH /api/kb/tags/:id — rename or recolor a tag */
export async function tag_update(
    id: string,
    body: { name?: string; color?: string },
): Promise<KbTag> {
    const validId = z.string().uuid().parse(id);
    const { name, color } = z.object({
        name: z.string().min(1).max(64).optional(),
        color: z.string().nullable().optional(),
    }).parse(body);

    const updates: Record<string, unknown> = {};
    if (name !== undefined) {
        updates.name = name;
        updates.slug = slugify(name);
    }
    if (color !== undefined) updates.color = color;

    if (Object.keys(updates).length === 0) throw new Error("No fields to update");

    const { data, error } = await supabase
        .from("kb_tags")
        .update(updates)
        .eq("id", validId)
        .select("id, name, slug, color, created_by, created_at")
        .single();

    if (error) {
        if (error.code === "23505") throw new Error(`A tag with that name already exists`);
        throw new Error(error.message);
    }

    console.log(`[kb] Updated tag ${validId}`);
    return data as KbTag;
}

/** DELETE /api/kb/tags/:id — delete tag (cascade removes kb_document_tags rows via FK) */
export async function tag_delete(id: string): Promise<void> {
    const validId = z.string().uuid().parse(id);

    // Collect affected document IDs before deletion so we can sync their chunk tag_ids
    const { data: links } = await supabase
        .from("kb_document_tags")
        .select("document_id")
        .eq("tag_id", validId);
    const affectedDocIds = (links ?? []).map((l: { document_id: string }) => l.document_id);

    const { error } = await supabase.from("kb_tags").delete().eq("id", validId);
    if (error) throw new Error(error.message);

    // Sync chunk tag_ids for all affected documents (FK cascade already removed the db_document_tags rows)
    for (const docId of affectedDocIds) {
        await syncChunkTagIds(docId);
    }

    console.log(`[kb] Deleted tag ${validId}`);
}

/** POST /api/kb/:docId/tags — add a tag to a document */
export async function doc_tag_add(docId: string, tagId: string): Promise<void> {
    const validDocId = z.string().uuid().parse(docId);
    const validTagId = z.string().uuid().parse(tagId);

    const { error } = await supabase
        .from("kb_document_tags")
        .insert({ document_id: validDocId, tag_id: validTagId });

    if (error) {
        if (error.code === "23505") return; // already linked — idempotent
        throw new Error(error.message);
    }

    await syncChunkTagIds(validDocId);
    console.log(`[kb] Added tag ${validTagId} to document ${validDocId}`);
}

/** DELETE /api/kb/:docId/tags/:tagId — remove a tag from a document */
export async function doc_tag_remove(docId: string, tagId: string): Promise<void> {
    const validDocId = z.string().uuid().parse(docId);
    const validTagId = z.string().uuid().parse(tagId);

    const { error } = await supabase
        .from("kb_document_tags")
        .delete()
        .eq("document_id", validDocId)
        .eq("tag_id", validTagId);

    if (error) throw new Error(error.message);

    await syncChunkTagIds(validDocId);
    console.log(`[kb] Removed tag ${validTagId} from document ${validDocId}`);
}
