import { z } from "zod";
import {
  CalendarSchema,
  type CalendarType,
} from "../../schemas/CalendarArtifactSchema";
import {
  CalendarEventSchema,
  type CalendarEventType,
} from "../../schemas/CalendarEventArtifactSchema";
import { CalendarSyncEventsEventSchema } from "../../schemas/CalendarSyncEventsEventSchema";
import { CalendarUpdateEventSchema } from "../../schemas/CalendarUpdateEventSchema";
import { createHash } from "crypto";
import { env } from "../config/env";
import { fetch_with_retry } from "../fetch_with_retry";
import { supabase } from "../config/supabase";
import { handleTranscriptWebhook } from "./transcript_webhook";
import { bot_settings_get } from "./bot_settings";
import { chunkText, createEmbeddings } from "./knowledge_base";
import { buildBotMetadataMap } from "./notes";
import { cleanTranscript } from "../lib/cleanTranscript";

// ─── Bot Type ───────────────────────────────────────────────
type BotType = "recording" | "voice_agent";

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

export async function recall_webhook(payload: any): Promise<void> {
  console.log(
    "[recall_webhook] RAW payload:",
    JSON.stringify(payload).slice(0, 500),
  );
  console.log(
    "[recall_webhook] event received:",
    payload?.event,
    "| type:",
    typeof payload?.event,
  );

  // Route transcript events to the transcript webhook handler
  if (
    payload?.event === "transcript.data" ||
    payload?.event === "transcript.done"
  ) {
    await handleTranscriptWebhook(payload);
    return;
  }

  // Recall sends "bot.done" when the bot has fully shut down and recordings are available.
  // Payload: { event: "bot.done", data: { bot: { id }, data: { code, sub_code, updated_at } } }
  if (payload?.event === "bot.done") {
    console.log(
      `[recall_webhook] bot.done received — bot_id="${payload?.data?.bot?.id}" code="${payload?.data?.data?.code}"`,
    );
    await handleBotDone(payload);
    return;
  }

  const result = z
    .discriminatedUnion("event", [
      CalendarUpdateEventSchema,
      CalendarSyncEventsEventSchema,
    ])
    .safeParse(payload);
  if (!result.success) {
    console.log(
      `Received unhandled Recall webhook event: ${JSON.stringify(payload)}`,
    );
    return;
  }
  const { event, data } = result.data;

  const calendar = await calendar_retrieve({ calendar_id: data.calendar_id });
  console.log(`Found calendar: ${JSON.stringify(calendar)}`);

  switch (event) {
    case "calendar.update": {
      console.log(`Calendar update event received: ${JSON.stringify(data)}`);
      break;
    }
    case "calendar.sync_events": {
      // Read global bot_settings once before processing the event batch
      const botSettings = await bot_settings_get();
      console.log(`[calendar.sync_events] bot_mode=${botSettings.bot_mode}`);

      // Auto-join toggle kontrolü — kapalıysa webhook'tan otomatik bot schedule etme
      if (!botSettings.auto_join_enabled) {
        console.log("Auto-join disabled — skipping automatic bot scheduling");
        return;
      }

      let next: string | null = null;
      do {
        const { results, next: new_next } = await calendar_events_list({
          updated_at__gte: data.last_updated_ts,
          calendar_id: data.calendar_id,
          next,
        });
        console.log(`Received ${results.length} calendar events.`);

        for (const calendar_event of results) {
          // Recall automatically unschedules bot if the calendar event is deleted.
          if (calendar_event.is_deleted) continue;
          // Skip calendar events that don't have a meeting URL or start time.
          if (!calendar_event.meeting_url || !calendar_event.start_time)
            continue;
          // Skip calendar events that have already passed.
          if (new Date(calendar_event.start_time) <= new Date()) continue;

          // Schedule exactly one bot type — voice_agent takes priority over recording
          const botTypeToSchedule: BotType = botSettings.bot_mode === "voice_agent"
            ? "voice_agent"
            : "recording";

          // Voice agent requires env vars to be configured
          if (
            botTypeToSchedule === "voice_agent" &&
            (!env.VOICE_AGENT_PAGE_URL || !env.VOICE_AGENT_WSS_URL)
          ) {
            console.warn(
              `[bot_settings] Mode is voice_agent but VOICE_AGENT_PAGE_URL/VOICE_AGENT_WSS_URL are not configured — skipping voice agent scheduling`,
            );
            continue;
          }

          try {
            // Resolve KB override for voice_agent bots
            let kb_id: string | undefined;
            if (botTypeToSchedule === "voice_agent") {
              const { data: kbOverride } = await supabase
                .from("meeting_kb_overrides")
                .select("kb_document_id")
                .eq("calendar_event_id", calendar_event.id)
                .maybeSingle();
              kb_id =
                kbOverride?.kb_document_id ??
                botSettings.active_kb_id ??
                undefined;
              console.log(
                `[calendar.sync_events] event=${calendar_event.id} effective_kb_id=${kb_id ?? "none"}`,
              );
            }

            await schedule_bot_for_calendar_event({
              calendar_event,
              calendar,
              bot_type: botTypeToSchedule,
              kb_id,
            });
            console.log(
              `[calendar_sync] Scheduled ${botTypeToSchedule} bot for event ` +
              `${calendar_event.id} (meeting: ${calendar_event.meeting_url})`,
            );
          } catch (err) {
            console.error(
              `Failed to schedule ${botTypeToSchedule} bot for calendar event ${calendar_event.id}:`,
              err,
            );
          }
        }
        next = new_next;
      } while (next);

      console.log(
        `Calendar sync events event received: ${JSON.stringify(data)}`,
      );
      break;
    }
  }

  return;
}

/**
 * Handle bot.done webhook: fetch the complete post-meeting transcript from Recall,
 * replace all real-time utterances in Supabase, and mark the meeting as done.
 * Always resolves without throwing so the caller always returns 200 to Recall.
 */
async function handleBotDone(body: any): Promise<void> {
  const botId: string | undefined = body?.data?.bot?.id;

  if (!botId) {
    console.error(
      "[handleBotDone] received without bot_id. Full payload:",
      JSON.stringify(body),
    );
    return;
  }

  const { data: meetingDoneCheck } = await supabase
    .from('meetings')
    .select('done')
    .eq('bot_id', botId)
    .single()

  if (meetingDoneCheck?.done === true) {
    console.log(`[handleBotDone] meeting already marked done for bot_id=${botId}, skipping`)
    return
  }

  console.log(
    `[handleBotDone] ── START bot_id=${botId} ─────────────────────────────`,
  );

  // Step 1: Fetch bot details from Recall v1 API to get transcript download URLs
  let downloadUrls: string[] = [];
  let botName: string = "";
  let botMeetingUrl: string | null = null;
  let botData: any = null;
  let inferredBotType: string = "recording";
  let meetingStartIso: string | null = null;
  try {
    const botResponse = await fetch_with_retry(
      `https://${env.RECALL_REGION}.recall.ai/api/v1/bot/${botId}/`,
      {
        method: "GET",
        headers: {
          Authorization: `${env.RECALL_API_KEY}`,
          "Content-Type": "application/json",
        },
      },
    );

    if (!botResponse.ok) {
      console.error(
        `[handleBotDone] Recall API fetch failed for bot ${botId}:`,
        await botResponse.text(),
      );
    } else {
      botData = await botResponse.json();

      // ── STEP 1 DIAGNOSTICS ──────────────────────────────────────────────────
      console.log(
        `[handleBotDone] bot_name="${botData?.bot_name}" meeting_url="${botData?.meeting_url}" status="${botData?.status_changes?.at(-1)?.code}"`,
      );
      const recordings: any[] = Array.isArray(botData?.recordings)
        ? botData.recordings
        : [];
      console.log(`[handleBotDone] recordings[] count: ${recordings.length}`);
      recordings.forEach((r: any, i: number) => {
        console.log(
          `[handleBotDone] recordings[${i}] full media_shortcuts:`,
          JSON.stringify(r?.media_shortcuts ?? null),
        );
      });

      // Collect transcript download URLs from ALL recordings entries.
      // When include_bot_in_recording.audio is true, Recall creates a separate recordings
      // entry for the bot's own output audio stream in addition to the participant stream.
      // Hardcoding recordings[0] would miss the bot's utterances entirely.
      downloadUrls = recordings
        .map((r: any, i: number) => {
          const url =
            r?.media_shortcuts?.transcript?.data?.download_url ?? null;
          console.log(
            `[handleBotDone] recordings[${i}] transcript download_url: ${url ?? "NONE"}`,
          );
          return url;
        })
        .filter((u: string | null): u is string => !!u);

      console.log(
        `[handleBotDone] transcript URLs found: ${downloadUrls.length} / ${recordings.length} recordings`,
      );

      // Backfill meeting_url, bot_type, and bot_name — important for calendar-scheduled bots
      // where these fields weren't available when the meetings row was first created.
      botMeetingUrl = botData?.meeting_url ?? null;
      botName = botData?.bot_name ?? "";
      inferredBotType = botName.toUpperCase().includes("WEYA VOICE")
        ? "voice_agent"
        : "recording";
      // Use the moment the bot entered in_call_recording as the meeting start anchor.
      meetingStartIso =
        (botData?.status_changes as any[] | undefined)?.find(
          (s: any) => s.code === "in_call_recording",
        )?.created_at ?? null;
      try {
        await supabase
          .from("meetings")
          .update({
            meeting_url: botMeetingUrl,
            bot_type: inferredBotType,
            bot_name: botName || null,
          })
          .eq("bot_id", botId);
        console.log(
          `Backfilled meeting_url=${botMeetingUrl} bot_type=${inferredBotType} bot_name="${botName}" for bot ${botId}`,
        );
      } catch (err) {
        console.error(
          `Failed to backfill meeting metadata for bot ${botId}:`,
          err,
        );
      }
    }
  } catch (err) {
    console.error(`Unexpected error fetching bot details for ${botId}:`, err);
  }

  if (!botData) {
    console.error(
      `[handleBotDone] Could not fetch bot details from Recall for bot ${botId}. Skipping transcription. This needs manual review.`,
    );
    return;
  }

  if (downloadUrls.length === 0) {
    console.warn(
      `[handleBotDone] No transcript URLs for bot ${botId} — Recall returned empty/no recordings. Marking done and exiting.`,
    );
    try {
      const { error } = await supabase
        .from("meetings")
        .update({ done: true })
        .eq("bot_id", botId);
      if (error) {
        console.error(
          `[handleBotDone] early-exit done flip failed for ${botId}, retrying:`,
          error,
        );
        const { error: retryError } = await supabase
          .from("meetings")
          .update({ done: true })
          .eq("bot_id", botId);
        if (retryError) {
          console.error(
            `[handleBotDone] retry also failed for ${botId}:`,
            retryError,
          );
        } else {
          console.log(
            `[handleBotDone] retry succeeded — marked ${botId} done via early-exit`,
          );
        }
      } else {
        console.log(
          `[handleBotDone] marked ${botId} done via early-exit (Recall returned empty/no transcripts)`,
        );
      }
    } catch (e) {
      console.error(
        `[handleBotDone] uncaught error in early-exit done flip for ${botId}:`,
        e,
      );
    }
    return;
  }

  // Step 2: Download and merge transcripts from all recordings entries.
  // Each entry is an array of segments: [{ speaker, words: [{text, start_timestamp, end_timestamp}] }]
  // Multiple entries occur when include_bot_in_recording.audio is true (bot audio = separate stream).
  type TranscriptSegment = {
    speaker?: string;
    participant?: { name?: string };
    words: unknown[];
  };
  let segments: TranscriptSegment[] = [];

  for (const [urlIndex, url] of downloadUrls.entries()) {
    console.log(
      `[handleBotDone] ── downloading transcript ${urlIndex + 1}/${downloadUrls.length}: ${url}`,
    );
    try {
      const transcriptResponse = await fetch(url);
      if (!transcriptResponse.ok) {
        console.error(
          `[handleBotDone] download failed (${transcriptResponse.status}) for url=${url}:`,
          await transcriptResponse.text(),
        );
        continue;
      }
      const rawText = await transcriptResponse.text();
      console.log(
        `[handleBotDone] raw transcript (first 500 chars): ${rawText.slice(0, 500)}`,
      );

      let rawJson: unknown;
      try {
        rawJson = JSON.parse(rawText);
      } catch (e) {
        console.error(`[handleBotDone] JSON parse failed for url=${url}:`, e);
        continue;
      }

      // Guard: transcript download must be a top-level array
      if (!Array.isArray(rawJson)) {
        console.error(
          `[handleBotDone] transcript is not an array — shape:`,
          JSON.stringify(rawJson).slice(0, 300),
        );
      } else {
        const incoming = rawJson as TranscriptSegment[];
        const speakers = [
          ...new Set(
            incoming.map((s) => s.participant?.name ?? s.speaker ?? "Unknown"),
          ),
        ];
        console.log(
          `[handleBotDone] transcript ${urlIndex + 1}: ${incoming.length} segments, speakers: ${JSON.stringify(speakers)}`,
        );
        segments.push(...incoming);
      }
    } catch (err) {
      console.error(`[handleBotDone] unexpected error for url=${url}:`, err);
    }
  }
  console.log(
    `[handleBotDone] merged total: ${segments.length} segments from ${downloadUrls.length} URL(s)`,
  );

  // Step 3: Supplement real-time utterances with the async (recorded) transcript.
  // The transcript.data webhook is the primary path, but it can miss utterances
  // due to network issues or delivery failures. The recorded transcript from
  // Recall is the authoritative source. If it has MORE segments than what we
  // received in real-time, replace with the complete version.
  // Voice agent bots: AssemblyAI async transcript arrives via transcript.done — skip Recall's sync segment check.
  if (inferredBotType !== "voice_agent" && segments.length > 0) {
    const { count: existingCount } = await supabase
      .from("utterances")
      .select("id", { count: "exact", head: true })
      .eq("bot_id", botId);

    const realTimeCount = existingCount ?? 0;

    if (realTimeCount > 0 && segments.length <= realTimeCount) {
      console.log(
        `[handleBotDone] real-time has ${realTimeCount} rows, async has ${segments.length} — real-time is complete, skipping`,
      );
    } else {
      // Either no real-time rows, or async transcript has more segments.
      // Replace with the complete recorded version.
      try {
        const rows = segments.map((seg) => {
          const raw = seg.participant?.name ?? seg.speaker ?? "";
          const isFallback = !raw || raw === "Unknown";
          const speaker = isFallback ? botName || "WEYA Voice Agent" : raw;
          if (isFallback) {
            console.log(
              `[handleBotDone] speaker normalized: "${raw}" → "${speaker}"`,
            );
          }
          return {
            bot_id: botId,
            speaker,
            words: seg.words,
            source: "realtime",
          };
        });

        const speakers = [...new Set(rows.map((r) => r.speaker))];

        if (realTimeCount > 0) {
          // Delete incomplete real-time rows before inserting complete version
          console.log(
            `[handleBotDone] async has ${segments.length} segments vs ${realTimeCount} real-time — replacing with complete transcript`,
          );
          const { error: deleteError } = await supabase
            .from("utterances")
            .delete()
            .eq("bot_id", botId);
          if (deleteError) {
            console.error(
              `[handleBotDone] failed to delete old utterances for bot ${botId}:`,
              deleteError,
            );
          }
        } else {
          console.log(
            `[handleBotDone] no real-time rows — inserting ${rows.length} async utterances`,
          );
        }

        const { error: insertError, data: insertData } = await supabase
          .from("utterances")
          .insert(rows)
          .select("id");

        if (insertError) {
          console.error(
            `[handleBotDone] Supabase insert FAILED for bot ${botId}:`,
            { error: insertError, segmentCount: rows.length },
          );
        } else {
          console.log(
            `[handleBotDone] Supabase insert OK — ${insertData?.length ?? rows.length} rows written for bot ${botId}, speakers: ${JSON.stringify(speakers)}`,
          );
        }
      } catch (err) {
        console.error(
          `Unexpected error inserting async utterances for bot ${botId}:`,
          err,
        );
      }
    }
  }

  // Step 4: Mark the meeting as done (runs regardless of transcript availability)
  try {
    const { error: doneError } = await supabase
      .from("meetings")
      .update({ done: true })
      .eq("bot_id", botId);

    if (doneError) {
      console.error(`Failed to mark meeting done for bot ${botId}:`, {
        bot_id: botId,
        error: doneError,
      });
    } else {
      console.log(`[handleBotDone] meeting marked done for bot ${botId}`);
    }
  } catch (err) {
    console.error(
      `[handleBotDone] unexpected error marking done for bot ${botId}:`,
      err,
    );
  }

  // Step 4b: Flip done=true on sibling bots that share the same meeting_url.
  // Covers the case where a calendar-scheduled bot and a webhook-upserted bot
  // both attended the same meeting but carry different bot_ids.
  if (botMeetingUrl && botMeetingUrl.trim() !== "") {
    try {
      const { error: siblingError } = await supabase
        .from("meetings")
        .update({ done: true })
        .eq("meeting_url", botMeetingUrl)
        .eq("done", false);

      if (siblingError) {
        console.error(
          `[handleBotDone] failed to flip sibling bots done for meeting_url=${botMeetingUrl}:`,
          siblingError,
        );
      } else {
        console.log(
          `[handleBotDone] sibling bots marked done for meeting_url=${botMeetingUrl}`,
        );
      }
    } catch (err) {
      console.error(
        `[handleBotDone] unexpected error flipping sibling bots for meeting_url=${botMeetingUrl}:`,
        err,
      );
    }
  }

  // Step 5: Auto-ingest transcript into Knowledge Base (non-blocking)
  // This enables the voice agent to answer questions about past meetings
  try {
    const { data: allUtterances } = await supabase
      .from("utterances")
      .select("speaker, words, timestamp")
      .eq("bot_id", botId)
      .order("timestamp", { ascending: true });

    if (allUtterances && allUtterances.length > 0) {
      // Build transcript text with speaker labels
      const transcriptText = allUtterances
        .map((row) => {
          const text = Array.isArray(row.words)
            ? row.words.map((w: any) => w.text).join(" ")
            : "";
          return `${row.speaker}: ${text}`;
        })
        .join("\n");

      // Skip very short transcripts (likely failed recordings)
      if (transcriptText.length < 100) {
        console.log(
          `[handleBotDone] Transcript too short (${transcriptText.length} chars) — skipping KB ingest`,
        );
      } else {
        // Dedup check using content hash
        const contentHash = createHash("sha256")
          .update(transcriptText)
          .digest("hex");
        const { data: existing } = await supabase
          .from("kb_documents")
          .select("id")
          .eq("content_hash", contentHash)
          .maybeSingle();

        if (existing) {
          console.log(
            `[handleBotDone] KB doc already exists for bot ${botId} (hash match) — skipping`,
          );
        } else {
          // Build a rich title: "Meeting Title — 27 Mart 2026 Cuma — Gülfem, Yiğit"
          const participants = [
            ...new Set(allUtterances.map((r) => r.speaker)),
          ].filter(
            (name) =>
              name !== "WEYA Voice Agent" &&
              name !== "WEYA by Light Eagle" &&
              name !== "Unknown",
          );

          const meetingDate = new Date(allUtterances[0].timestamp);
          const dateStr = meetingDate.toLocaleDateString("tr-TR", {
            year: "numeric",
            month: "long",
            day: "numeric",
            weekday: "long",
          });

          // Try to get calendar title
          let calendarTitle = "Toplantı";
          try {
            const metaMap = await buildBotMetadataMap([botId]);
            const meta = metaMap.get(botId);
            if (meta?.title) calendarTitle = meta.title;
          } catch (metaErr) {
            console.error(
              `[handleBotDone] Failed to get calendar title for KB ingest:`,
              metaErr,
            );
          }

          const meetingType = normalizeMeetingType(calendarTitle);

          const docTitle = participants.length > 0
            ? `${calendarTitle} — ${dateStr} — ${participants.join(", ")}`
            : `${calendarTitle} — ${dateStr}`;

          // Get transcripts category
          const { data: cat } = await supabase
            .from("kb_categories")
            .select("id")
            .eq("name", "transcripts")
            .single();

          if (!cat) {
            console.error(
              `[handleBotDone] 'transcripts' category not found — run migration first`,
            );
          } else {
            // Create KB document — set created_at to actual meeting date so date filters work
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
                  meeting_type: meetingType,
                  meeting_title: calendarTitle,
                },
                created_at: meetingDate.toISOString(),
              })
              .select("id")
              .single();

            if (docErr) {
              console.error(`[handleBotDone] KB doc insert failed:`, docErr);
            } else {
              // Chunk and embed
              const chunks = chunkText(transcriptText);
              // Prepend document title to each chunk for better semantic search
              const chunksWithTitle = chunks.map(chunk => `[${docTitle}]\n\n${chunk}`);
              const embeddings = await createEmbeddings(chunksWithTitle);

              const chunkRows = chunksWithTitle.map((chunk, i) => ({
                document_id: doc.id,
                chunk_index: i,
                content: chunk,
                token_count: Math.ceil(chunk.length / 4),
                embedding: JSON.stringify(embeddings[i]),
              }));

              const { error: chunkErr } = await supabase
                .from("kb_chunks")
                .insert(chunkRows);

              if (chunkErr) {
                console.error(
                  `[handleBotDone] KB chunks insert failed:`,
                  chunkErr,
                );
              } else {
                console.log(
                  `[handleBotDone] ✅ Auto-ingested to KB: "${docTitle}" (${chunks.length} chunks, ${transcriptText.length} chars)`,
                );
              }
            }
          }
        }
      }
    } else {
      console.log(
        `[handleBotDone] No utterances for bot ${botId} — skipping KB ingest`,
      );
    }
  } catch (kbErr) {
    // KB ingest failure must NEVER break the webhook — Recall expects 200
    console.error(`[handleBotDone] KB auto-ingest failed (non-fatal):`, kbErr);
  }

  console.log(
    `[handleBotDone] ── END bot_id=${botId} ───────────────────────────────`,
  );
}

/**
 * Retrieve a calendar from Recall.
 */
export async function calendar_retrieve(args: { calendar_id: string }) {
  const { calendar_id } = z
    .object({
      calendar_id: z.string(),
    })
    .parse(args);

  const response = await fetch_with_retry(
    `https://${env.RECALL_REGION}.recall.ai/api/v2/calendars/${calendar_id}`,
    {
      method: "GET",
      headers: {
        Authorization: `${env.RECALL_API_KEY}`,
        "Content-Type": "application/json",
      },
    },
  );
  if (!response.ok) throw new Error(await response.text());

  return CalendarSchema.parse(await response.json());
}

/**
 * List calendar events for a given calendar from Recall.
 */
export async function calendar_events_list(args: {
  updated_at__gte?: string | null;
  calendar_id: string;
  next: string | null;
}) {
  const { updated_at__gte, calendar_id, next } = z
    .object({
      updated_at__gte: z.string().nullish(),
      calendar_id: z.string(),
      next: z.string().nullable(),
    })
    .parse(args);

  const url = new URL(
    `https://${env.RECALL_REGION}.recall.ai/api/v2/calendar-events/`,
  );
  url.searchParams.set("calendar_id", calendar_id);
  if (next) url.searchParams.set("next", next);
  if (updated_at__gte) url.searchParams.set("updated_at__gte", updated_at__gte);

  const response = await fetch_with_retry(url.toString(), {
    method: "GET",
    headers: {
      Authorization: `${env.RECALL_API_KEY}`,
      "Content-Type": "application/json",
    },
  });
  if (!response.ok) throw new Error(await response.text());

  return z
    .object({
      next: z.string().nullable(),
      results: CalendarEventSchema.array(),
    })
    .parse(await response.json());
}

/**
 * Retrieve a calendar event from Recall.
 */
export async function calendar_event_retrieve(args: {
  calendar_event_id: string;
}) {
  const { calendar_event_id } = z
    .object({
      calendar_event_id: z.string(),
    })
    .parse(args);

  const response = await fetch_with_retry(
    `https://${env.RECALL_REGION}.recall.ai/api/v2/calendar-events/${calendar_event_id}`,
    {
      method: "GET",
      headers: {
        Authorization: `${env.RECALL_API_KEY}`,
        "Content-Type": "application/json",
      },
    },
  );
  if (!response.ok) throw new Error(await response.text());

  return CalendarEventSchema.parse(await response.json());
}

/**
 * Unschedule a bot for a given calendar event.
 */
export async function unschedule_bot_for_calendar_event(args: {
  calendar_event_id: string;
  deduplication_key?: string;
}) {
  const { calendar_event_id } = z
    .object({
      calendar_event_id: z.string(),
    })
    .parse(args);

  const body: Record<string, any> = {};
  if (args.deduplication_key) {
    body.deduplication_key = args.deduplication_key;
  }

  const response = await fetch_with_retry(
    `https://${env.RECALL_REGION}.recall.ai/api/v2/calendar-events/${calendar_event_id}/bot`,
    {
      method: "DELETE",
      headers: {
        Authorization: `${env.RECALL_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: Object.keys(body).length > 0 ? JSON.stringify(body) : undefined,
    },
  );
  if (!response.ok) throw new Error(await response.text());
  return CalendarEventSchema.parse(await response.json());
}

/**
 * Schedule a bot for a given calendar event.
 * It will show up in the bot list as `${calendar.platform_email}'s notetaker'`.
 */
export async function schedule_bot_for_calendar_event(args: {
  calendar: CalendarType;
  calendar_event: CalendarEventType;
  bot_type?: BotType;
  kb_id?: string;
}) {
  const { calendar, calendar_event } = z
    .object({
      calendar: CalendarSchema,
      calendar_event: CalendarEventSchema,
    })
    .parse(args);

  const bot_type: BotType = args.bot_type ?? "recording";
  const kb_id: string | undefined = args.kb_id;

  const { deduplication_key } = generate_bot_deduplication_key({
    one_bot_per: "meeting",
    email: calendar.platform_email!,
    meeting_url: calendar_event.meeting_url!,
    meeting_start_timestamp: calendar_event.start_time,
    bot_type,
  });

  // Bot tipine göre config oluştur
  let bot_config: Record<string, any>;

  if (bot_type === "voice_agent") {
    // Voice Agent: Output Media ile web sayfası render eder
    if (!env.VOICE_AGENT_PAGE_URL || !env.VOICE_AGENT_WSS_URL) {
      throw new Error(
        "Voice agent environment variables (VOICE_AGENT_PAGE_URL, VOICE_AGENT_WSS_URL) are not configured",
      );
    }

    const pageParams = new URLSearchParams({ wss: env.VOICE_AGENT_WSS_URL });
    if (kb_id) pageParams.set("kb", kb_id);
    const output_media_url = `${env.VOICE_AGENT_PAGE_URL}?${pageParams.toString()}`;

    bot_config = {
      bot_name: "WEYA Voice Agent",
      variant: {
        zoom: "web_4_core",
        google_meet: "web_4_core",
        microsoft_teams: "web_4_core",
      },
      output_media: {
        camera: {
          kind: "webpage",
          config: {
            url: output_media_url,
          },
        },
      },
      recording_config: {
        transcript: {
          provider: {
            assembly_ai_async_chunked: {
              language_code: "tr",
              speaker_labels: true,
              speakers_expected: 3,
            },
          },
        },
        realtime_endpoints: [
          {
            type: "webhook",
            url: `https://${env.RAILWAY_DOMAIN}/api/webhooks/transcript`,
            events: ["transcript.data", "transcript.partial_data"],
          },
        ],
        include_bot_in_recording: {
          audio: true,
        },
      },
    };
  } else {
    // Recording Bot: Mevcut config — transcript + realtime webhook
    bot_config = {
      bot_name: `WEYA by Light Eagle`,
      // meeting_url and start_time is automatically updated by Recall when we call the schedule bot for calendar event endpoint.
      recording_config: {
        transcript: {
          provider: {
            recallai_streaming: {
              language: "auto",
            },
          },
        },
        realtime_endpoints: [
          {
            type: "webhook",
            url: `https://${env.RAILWAY_DOMAIN}/api/webhooks/transcript`,
            events: ["transcript.data", "transcript.partial_data"],
          },
        ],
      },
    };
  }

  // Fix A2: If this calendar event already has bots scheduled, skip the Recall POST
  // to avoid creating duplicate bots for the same event.
  const existingBots = calendar_event.bots ?? [];
  let updatedEvent: CalendarEventType;

  if (existingBots.length > 0) {
    console.log(
      `[schedule_bot] Event ${calendar_event.id} already has ` +
      `${existingBots.length} bot(s) scheduled — skipping Recall API call.`,
    );
    updatedEvent = calendar_event;
  } else {
    const response = await fetch_with_retry(
      `https://${env.RECALL_REGION}.recall.ai/api/v2/calendar-events/${calendar_event.id}/bot`,
      {
        method: "POST",
        headers: {
          Authorization: `${env.RECALL_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          deduplication_key,
          bot_config,
        }),
      },
    );
    if (!response.ok) throw new Error(await response.text());
    updatedEvent = CalendarEventSchema.parse(await response.json());
  }

  // Extract attendee emails from the raw calendar event (Google: raw.attendees[].email,
  // Outlook: raw.attendees[].emailAddress.address). Fall back to empty array if absent.
  const rawAttendees: unknown[] = Array.isArray(calendar_event.raw?.attendees)
    ? (calendar_event.raw.attendees as unknown[])
    : [];
  const attendeeEmails: string[] = rawAttendees.reduce<string[]>((acc, a) => {
    if (a !== null && typeof a === "object") {
      const obj = a as Record<string, unknown>;
      const google = typeof obj["email"] === "string" ? obj["email"] : null;
      const outlook =
        obj["emailAddress"] !== null &&
        typeof obj["emailAddress"] === "object" &&
        typeof (obj["emailAddress"] as Record<string, unknown>)["address"] === "string"
          ? ((obj["emailAddress"] as Record<string, unknown>)["address"] as string)
          : null;
      const email = google ?? outlook;
      if (email) acc.push(email);
    }
    return acc;
  }, []);

  // Fix A3: Only upsert the bot that matches the bot_type being scheduled.
  // This prevents the recording-bot row from being written when scheduling a voice_agent
  // (and vice versa), which was the root cause of ghost duplicate meetings.
  const botsToUpsert = updatedEvent.bots.filter((bot) => {
    const key: string = bot.deduplication_key ?? "";
    return bot_type === "voice_agent" ? key.startsWith("va-") : key.startsWith("rec-");
  });

  if (botsToUpsert.length === 0) {
    console.warn(
      `[schedule_bot] No matching bot found in updatedEvent.bots[] for type ${bot_type} ` +
      `on event ${calendar_event.id}. Dedup keys present: ` +
      `[${updatedEvent.bots.map((b) => b.deduplication_key).join(", ")}]`,
    );
    return updatedEvent;
  }

  if (calendar.platform_email) {
    await Promise.all(
      botsToUpsert.map(async (bot) => {
        // ignoreDuplicates: true — never reset done=true on re-sync
        const { error } = await supabase
          .from("meetings")
          .upsert(
            {
              bot_id: bot.bot_id,
              user_email: calendar.platform_email,
              done: false,
              attendee_emails: attendeeEmails,
              meeting_start_time: calendar_event.start_time ?? null,
              meeting_title: calendar_event.raw?.summary ?? calendar_event.raw?.subject ?? null,
            },
            { onConflict: "bot_id", ignoreDuplicates: true },
          );
        if (error) {
          console.error(`[schedule_bot] Failed to pre-store user_email for bot ${bot.bot_id}:`, error);
        }
        // Refresh attendee list on already-existing rows without touching done
        await supabase
          .from("meetings")
          .update({ attendee_emails: attendeeEmails })
          .eq("bot_id", bot.bot_id)
          .eq("done", false);
      }),
    );
  }

  return updatedEvent;
}

/**
 * Generate a deduplication key for a bot based on the one_bot_per, email, meeting_url, and meeting_start_timestamp.
 */
function generate_bot_deduplication_key(args: {
  one_bot_per: "user" | "email_domain" | "meeting";
  email: string;
  meeting_url: string;
  meeting_start_timestamp: string;
  bot_type: BotType;
}) {
  const { one_bot_per, email, meeting_url, meeting_start_timestamp, bot_type } =
    z
      .object({
        one_bot_per: z.enum(["user", "email_domain", "meeting"]),
        email: z.string(),
        meeting_url: z.string(),
        meeting_start_timestamp: z.string(),
        bot_type: z.enum(["recording", "voice_agent"]),
      })
      .parse(args);

  // Prefix: "rec" veya "va" — aynı event'e 2 farklı bot gidebilsin
  const prefix = bot_type === "recording" ? "rec" : "va";

  switch (one_bot_per) {
    case "user": {
      // Deduplicate at user level: every user who has a bot scheduled will get their own bot.
      return {
        deduplication_key: `${prefix}-${email}-${meeting_url}-${meeting_start_timestamp}`,
      };
    }
    case "email_domain": {
      // Deduplicate at company/domain level: one shared bot for everyone from that domain on this meeting occurrence.
      return {
        deduplication_key: `${prefix}-${email.split("@")[1]}-${meeting_url}-${meeting_start_timestamp}`,
      };
    }
    case "meeting": {
      // Deduplicate at meeting level: one bot for the entire meeting regardless of who scheduled it.
      return {
        deduplication_key: `${prefix}-${meeting_url}-${meeting_start_timestamp}`,
      };
    }
  }
}
