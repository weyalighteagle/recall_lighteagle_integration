import { createHash } from "crypto";
import { supabase } from "../config/supabase";
import { chunkText, createEmbeddings } from "./knowledge_base";

/**
 * Normalize a calendar title to a snake_case meeting type key.
 * e.g. "Yapay Zeka Takım Toplantısı" → "yapay_zeka_takim_toplantisi"
 */
export function normalizeMeetingType(title: string): string {
  if (!title || title.trim() === "") return "general";
  return title
    .toLowerCase()
    .replace(/ğ/g, "g")
    .replace(/ü/g, "u")
    .replace(/ş/g, "s")
    .replace(/ı/g, "i")
    .replace(/ö/g, "o")
    .replace(/ç/g, "c")
    .replace(/[^a-z0-9\s]/g, "")
    .trim()
    .replace(/\s+/g, "_");
}

export async function upsertIngestionLog(
  botId: string,
  orgId: string | null,
  status: "pending" | "processing" | "success" | "failed" | "skipped",
  extra: { error_message?: string; chunk_count?: number } = {}
): Promise<void> {
  try {
    await supabase.from("kb_ingestion_log").upsert(
      {
        bot_id: botId,
        org_id: orgId,
        status,
        error_message: extra.error_message ?? null,
        chunk_count: extra.chunk_count ?? null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "bot_id" }
    );
  } catch (e) {
    console.error("[ingestion_log] Failed to write log row:", e);
    // Never throw — logging must never break the webhook
  }
}

export interface IngestResult {
  skipped: boolean;
  reason?: string;
  chunkCount?: number;
}

/**
 * Shared KB ingest helper used by both handleBotDone (recording bots) and
 * the assembly_ai_async transcript.done path (voice_agent bots).
 * Throws on hard errors so the caller's outer try/catch can write a "failed" log.
 */
export async function ingestTranscriptToKB(params: {
  botId: string;
  transcriptText: string;
  docTitle: string;
  meetingDate: Date;
  meetingType?: string;
  calendarTitle?: string;
  tagIds?: string[];
}): Promise<IngestResult> {
  const { botId, transcriptText, docTitle, meetingDate, meetingType, calendarTitle, tagIds } = params;

  if (transcriptText.length < 100) {
    await upsertIngestionLog(botId, null, "skipped",
      { error_message: `Transcript too short (${transcriptText.length} chars)` });
    return { skipped: true, reason: `Too short (${transcriptText.length} chars)` };
  }

  const contentHash = createHash("sha256").update(transcriptText).digest("hex");
  const { data: existing } = await supabase
    .from("kb_documents")
    .select("id")
    .eq("content_hash", contentHash)
    .maybeSingle();

  if (existing) {
    await upsertIngestionLog(botId, null, "skipped",
      { error_message: "Duplicate content — already ingested" });
    return { skipped: true, reason: "Duplicate content" };
  }

  const { data: cat } = await supabase
    .from("kb_categories")
    .select("id")
    .eq("name", "transcripts")
    .single();

  if (!cat) {
    throw new Error("'transcripts' category not found — run migration first");
  }

  const { data: doc, error: docErr } = await supabase
    .from("kb_documents")
    .insert({
      title: docTitle,
      category_id: cat.id,
      source_type: "transcript",
      content_hash: contentHash,
      metadata: {
        botId,
        meetingDate: meetingDate.toISOString(),
        meeting_type: meetingType ?? null,
        meeting_title: calendarTitle ?? docTitle,
      },
      created_at: meetingDate.toISOString(),
    })
    .select("id")
    .single();

  if (docErr) throw new Error(`KB doc insert failed: ${docErr.message}`);

  const chunks = chunkText(transcriptText);
  const chunksWithTitle = chunks.map((chunk) => `[${docTitle}]\n\n${chunk}`);
  const embeddings = await createEmbeddings(chunksWithTitle);

  const chunkRows = chunksWithTitle.map((chunk, i) => ({
    document_id: doc.id,
    chunk_index: i,
    content: chunk,
    token_count: Math.ceil(chunk.length / 4),
    embedding: JSON.stringify(embeddings[i]),
    tag_ids: tagIds && tagIds.length > 0 ? tagIds : null,
  }));

  const { error: chunkErr } = await supabase.from("kb_chunks").insert(chunkRows);
  if (chunkErr) throw new Error(`KB chunks insert failed: ${chunkErr.message}`);

  // Auto-tag the KB document with tags passed by the caller (already written to tag_ids on chunk rows)
  if (tagIds && tagIds.length > 0) {
    await supabase.from("kb_document_tags").insert(
      tagIds.map((tid: string) => ({ document_id: doc.id, tag_id: tid }))
    );
    console.log(`[kb_ingest] Auto-tagged doc ${doc.id} with ${tagIds.length} tag(s)`);
  }

  await upsertIngestionLog(botId, null, "success", { chunk_count: chunkRows.length });
  return { skipped: false, chunkCount: chunkRows.length };
}
