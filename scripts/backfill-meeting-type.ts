/**
 * One-time backfill: adds meeting_type and meeting_title to existing transcript kb_documents.
 *
 * The document title format is: "Calendar Title — 27 Mart 2026 Cuma — Gülfem, Yiğit"
 * We extract the part before the first " — " as the meeting title.
 *
 * Usage:
 *   npx tsx scripts/backfill-meeting-type.ts --dry-run   # preview changes
 *   npx tsx scripts/backfill-meeting-type.ts              # apply changes
 */

import { createClient } from "@supabase/supabase-js";
import { normalizeMeetingType } from "../src/api/handlers/recall_webhook";

const DRY_RUN = process.argv.includes("--dry-run");

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error("SUPABASE_URL and SUPABASE_SERVICE_KEY env vars are required");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function main() {
  console.log(`[backfill] DRY_RUN=${DRY_RUN}`);

  const { data: docs, error } = await supabase
    .from("kb_documents")
    .select("id, title, metadata")
    .eq("source_type", "transcript");

  if (error) {
    console.error("[backfill] Failed to fetch documents:", error);
    process.exit(1);
  }

  console.log(`[backfill] Found ${docs?.length ?? 0} transcript documents`);

  let updated = 0;
  let skipped = 0;

  for (const doc of docs ?? []) {
    // Already has meeting_type — skip unless it's missing
    if (doc.metadata?.meeting_type) {
      skipped++;
      continue;
    }

    // Extract meeting title from doc title: "Calendar Title — 27 Mart 2026 ..."
    const dashIdx = doc.title.indexOf(" — ");
    const meetingTitle = dashIdx !== -1 ? doc.title.slice(0, dashIdx) : doc.title;
    const meetingType = normalizeMeetingType(meetingTitle);

    const newMetadata = {
      ...doc.metadata,
      meeting_type: meetingType,
      meeting_title: meetingTitle,
    };

    console.log(
      `[backfill] id=${doc.id} | "${doc.title}"\n` +
      `           → meeting_title="${meetingTitle}" meeting_type="${meetingType}"`
    );

    if (!DRY_RUN) {
      const { error: updateError } = await supabase
        .from("kb_documents")
        .update({ metadata: newMetadata })
        .eq("id", doc.id);

      if (updateError) {
        console.error(`[backfill] Failed to update doc ${doc.id}:`, updateError);
      } else {
        updated++;
      }
    } else {
      updated++;
    }
  }

  console.log(
    `\n[backfill] Done. ${DRY_RUN ? "Would update" : "Updated"}: ${updated}, Skipped (already had meeting_type): ${skipped}`
  );

  if (DRY_RUN) {
    console.log("\n[backfill] Run without --dry-run to apply changes.");
  }
}

main().catch((err) => {
  console.error("[backfill] Unexpected error:", err);
  process.exit(1);
});
