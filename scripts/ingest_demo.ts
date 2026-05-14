import { createEmbeddings, chunkText } from "../src/api/handlers/knowledge_base";
import { supabase } from "../src/api/config/supabase";
import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";

const DEMO_TAG_ID  = "764d778a-69c2-45ec-b5f4-585a8a17255b";
const CATEGORY_ID  = "1514cc1c-9f9f-4675-a41b-dd85bc85ebda";
const DEMO_FILES_DIR = path.join(import.meta.dirname, "demo_files");
const ORG_ID       = "d6d7b0e1-cf72-4c17-b228-433571e8efbb";

function parseFilename(filename: string): {
    meeting_date: string;
    meeting_title: string;
    participants: string[];
    meeting_type: string;
} {
    // Strip .txt extension for parsing
    const base = filename.replace(/\.txt$/i, "");
    const parts = base.split(" - ");
    const meeting_date  = parts[0]?.trim() ?? "";
    const meeting_title = parts[1]?.trim() ?? "";
    const participantsPart = parts[2]?.trim() ?? "";
    const participants  = participantsPart.split(",").map((p) => p.trim()).filter(Boolean);
    const typeMatch     = base.match(/\[([^\]]+)\]/);
    const meeting_type  = (typeMatch?.[1] ?? "").toLowerCase();
    return { meeting_date, meeting_title, participants, meeting_type };
}

async function main() {
    const files = fs.readdirSync(DEMO_FILES_DIR).filter((f) => f.endsWith(".txt"));

    if (files.length === 0) {
        console.log("No .txt files found in demo_files/");
        process.exit(0);
    }

    let ingested   = 0;
    let skipped    = 0;
    let failed     = 0;
    let totalChunks = 0;

    for (const filename of files) {
        try {
            const { meeting_date, meeting_title, participants, meeting_type } = parseFilename(filename);

            const rawContent = fs.readFileSync(path.join(DEMO_FILES_DIR, filename), "utf-8");

            const enrichedContent = [
                `Tarih: ${meeting_date} | Tür: ${meeting_type.toUpperCase()} | Katılımcılar: ${participants.join(", ")}`,
                `Başlık: ${meeting_title}`,
                "---",
                rawContent,
            ].join("\n");

            const hash = createHash("sha256").update(enrichedContent).digest("hex");

            const { data: existing } = await supabase
                .from("kb_documents")
                .select("id")
                .eq("content_hash", hash)
                .maybeSingle();

            if (existing) {
                console.log(`⏭  skipped (already ingested): ${filename}`);
                skipped++;
                continue;
            }

            const { data: doc, error: docErr } = await supabase
                .from("kb_documents")
                .insert({
                    title: `${meeting_date} - ${meeting_title}`,
                    category_id: CATEGORY_ID,
                    source_type: "historical_transcript",
                    content_hash: hash,
                    org_id: ORG_ID,
                    metadata: {
                        meeting_date,
                        meeting_title,
                        participants,
                        meeting_type,
                        source: "transkriptor_historical",
                    },
                })
                .select("id")
                .single();

            if (docErr || !doc) throw new Error(docErr?.message ?? "Failed to insert document");

            const chunks    = chunkText(enrichedContent);
            const embeddings = await createEmbeddings(chunks);

            const chunkRows = chunks.map((chunk, i) => ({
                document_id: doc.id,
                chunk_index: i,
                content: chunk,
                token_count: Math.ceil(chunk.length / 4),
                embedding: JSON.stringify(embeddings[i]),
                org_id: ORG_ID,
                tag_ids: [DEMO_TAG_ID],
                is_active: true,
            }));

            const { error: chunkErr } = await supabase.from("kb_chunks").insert(chunkRows);
            if (chunkErr) throw new Error(chunkErr.message);

            const { error: tagErr } = await supabase
                .from("kb_document_tags")
                .insert({ document_id: doc.id, tag_id: DEMO_TAG_ID });
            if (tagErr) throw new Error(tagErr.message);

            const { error: logErr } = await supabase
                .from("kb_ingestion_log")
                .insert({
                    bot_id: filename,
                    status: "success",
                    chunk_count: chunks.length,
                    note: "historical backfill demo",
                });
            if (logErr) throw new Error(logErr.message);

            console.log(`✓  ${filename} — ${chunks.length} chunks`);
            ingested++;
            totalChunks += chunks.length;

        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            await supabase.from("kb_ingestion_log").insert({
                bot_id: filename,
                status: "failed",
                error: message,
                note: "historical backfill demo",
            });
            console.log(`✗  ${filename} — ${message}`);
            failed++;
        }
    }

    console.log("────────────────────────────────");
    console.log(`✓ ingested:  ${ingested}`);
    console.log(`⏭ skipped:   ${skipped}`);
    console.log(`✗ failed:    ${failed}`);
    console.log(`∑ chunks:    ${totalChunks}`);
    console.log("────────────────────────────────");
}

main();
