/**
 * Re-ingest kb_documents that have no kb_chunks (missing embeddings).
 *
 * For each document, fetches utterances from the `utterances` table using the
 * botId stored in metadata, rebuilds the transcript text, chunks it, embeds it,
 * and inserts the chunks into kb_chunks.
 *
 * Usage:
 *   npx tsx scripts/reingest-missing-chunks.ts --dry-run   # preview only
 *   npx tsx scripts/reingest-missing-chunks.ts              # apply
 *
 * Env vars required: SUPABASE_URL, SUPABASE_SERVICE_KEY, OPENAI_API_KEY
 */

import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { createClient } from "@supabase/supabase-js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const DRY_RUN = process.argv.includes("--dry-run");

// ── Env validation ────────────────────────────────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !OPENAI_API_KEY) {
  const missing = [
    !SUPABASE_URL && "SUPABASE_URL",
    !SUPABASE_SERVICE_KEY && "SUPABASE_SERVICE_KEY",
    !OPENAI_API_KEY && "OPENAI_API_KEY",
  ].filter(Boolean);
  console.error(`[reingest] Missing env vars: ${missing.join(", ")}`);
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// TARGET_IDS removed — script now discovers all transcript docs with 0 chunks dynamically.

// ── chunkText — kept in sync with src/api/handlers/knowledge_base.ts ─────────
function chunkText(text: string, maxChars = 1000, overlapChars = 200): string[] {
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

// ── createEmbeddings — identical logic to src/api/handlers/knowledge_base.ts ─
async function createEmbeddings(texts: string[]): Promise<number[][]> {
  const allEmbeddings: number[][] = [];
  const batchSize = 100;

  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    const response = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: "text-embedding-3-small", input: batch }),
    });
    if (!response.ok) {
      throw new Error(`OpenAI embeddings error: ${await response.text()}`);
    }
    const data = await response.json();
    allEmbeddings.push(...data.data.map((d: any) => d.embedding));
  }
  return allEmbeddings;
}

// ── Sleep helper ──────────────────────────────────────────────────────────────
function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`[reingest] DRY_RUN=${DRY_RUN}`);
  console.log(`[reingest] Discovering all transcript documents with 0 chunks...`);

  // Fetch all transcript documents
  const { data: allDocs, error: allDocsErr } = await supabase
    .from("kb_documents")
    .select("id, title, metadata, created_at")
    .eq("source_type", "transcript")
    .eq("is_active", true);

  if (allDocsErr) {
    console.error("[reingest] Failed to fetch documents:", allDocsErr);
    process.exit(1);
  }

  if (!allDocs || allDocs.length === 0) {
    console.log("[reingest] No transcript documents found.");
    return;
  }

  // Filter to only those with 0 chunks
  const docs = [];
  for (const doc of allDocs) {
    const { count } = await supabase
      .from("kb_chunks")
      .select("id", { count: "exact", head: true })
      .eq("document_id", doc.id);
    if ((count ?? 0) === 0) docs.push(doc);
  }

  if (docs.length === 0) {
    console.log(`[reingest] All ${allDocs.length} transcript documents already have chunks. Nothing to do.`);
    return;
  }

  console.log(`[reingest] Found ${docs.length} document(s) with 0 chunks (out of ${allDocs.length} total transcripts).\n`);
  docs.forEach(d => console.log(`[reingest]   - "${d.title}" (${d.id})`));
  console.log();

  let succeeded = 0;
  let failed = 0;

  for (const doc of docs) {
    console.log(`[reingest] ── Processing: "${doc.title}" (${doc.id})`);

    const botId: string | undefined = doc.metadata?.botId;
    if (!botId) {
      console.warn(`[reingest]   SKIP — no botId in metadata`);
      failed++;
      continue;
    }

    console.log(`[reingest]   botId=${botId}`);

    // Double-check: confirm there really are no chunks (guard against re-runs)
    const { count: chunkCount } = await supabase
      .from("kb_chunks")
      .select("id", { count: "exact", head: true })
      .eq("document_id", doc.id);

    if ((chunkCount ?? 0) > 0) {
      console.log(`[reingest]   SKIP — already has ${chunkCount} chunk(s)`);
      succeeded++;
      continue;
    }

    // Fetch utterances for this bot
    const { data: utterances, error: uttErr } = await supabase
      .from("utterances")
      .select("speaker, words, timestamp")
      .eq("bot_id", botId)
      .order("timestamp", { ascending: true });

    if (uttErr) {
      console.error(`[reingest]   ERROR fetching utterances:`, uttErr);
      failed++;
      continue;
    }

    if (!utterances || utterances.length === 0) {
      console.warn(`[reingest]   SKIP — no utterances found for botId=${botId}`);
      failed++;
      continue;
    }

    console.log(`[reingest]   Utterances: ${utterances.length}`);

    // Rebuild transcript text
    const transcriptText = utterances
      .map((row) => {
        const text = Array.isArray(row.words)
          ? row.words.map((w: any) => w.text).join(" ")
          : "";
        return `${row.speaker}: ${text}`;
      })
      .join("\n");

    if (transcriptText.length < 100) {
      console.warn(`[reingest]   SKIP — transcript too short (${transcriptText.length} chars)`);
      failed++;
      continue;
    }

    console.log(`[reingest]   Transcript: ${transcriptText.length} chars`);

    // Chunk (same logic as handleBotDone — prepend doc title to each chunk)
    const chunks = chunkText(transcriptText);
    const chunksWithTitle = chunks.map((chunk) => `[${doc.title}]\n\n${chunk}`);

    console.log(`[reingest]   Chunks: ${chunksWithTitle.length}`);

    if (DRY_RUN) {
      console.log(`[reingest]   DRY_RUN — would insert ${chunksWithTitle.length} chunks`);
      succeeded++;
      continue;
    }

    // Create embeddings
    let embeddings: number[][];
    try {
      embeddings = await createEmbeddings(chunksWithTitle);
      console.log(`[reingest]   Embeddings created: ${embeddings.length}`);
    } catch (embErr) {
      console.error(`[reingest]   ERROR creating embeddings:`, embErr);
      failed++;
      continue;
    }

    // Insert chunks
    const chunkRows = chunksWithTitle.map((chunk, i) => ({
      document_id: doc.id,
      chunk_index: i,
      content: chunk,
      token_count: Math.ceil(chunk.length / 4),
      embedding: JSON.stringify(embeddings[i]),
    }));

    const { error: insertErr } = await supabase.from("kb_chunks").insert(chunkRows);

    if (insertErr) {
      console.error(`[reingest]   ERROR inserting chunks:`, insertErr);
      failed++;
      continue;
    }

    console.log(`[reingest]   ✅ Inserted ${chunkRows.length} chunks for "${doc.title}"`);
    succeeded++;

    // Delay between documents to avoid OpenAI rate limits
    if (docs.indexOf(doc) < docs.length - 1) {
      console.log(`[reingest]   Waiting 1s before next document...`);
      await sleep(1000);
    }
  }

  console.log(`\n[reingest] Done. Succeeded: ${succeeded}, Failed/Skipped: ${failed}`);

  if (DRY_RUN) {
    console.log("[reingest] Run without --dry-run to apply changes.");
  }
}

main().catch((err) => {
  console.error("[reingest] Unexpected error:", err);
  process.exit(1);
});
