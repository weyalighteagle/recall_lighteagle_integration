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
import { env } from "../config/env";
import { fetch_with_retry } from "../fetch_with_retry";
import { supabase } from "../config/supabase";
import { handleTranscriptWebhook } from "./transcript_webhook";
import { bot_settings_get } from "./bot_settings";
import { cleanTranscript } from "../lib/cleanTranscript";
import { buildBotMetadataMap } from "./notes";
import { normalizeMeetingType, upsertIngestionLog, ingestTranscriptToKB } from "./kb_ingest";

// ─── Bot Type ───────────────────────────────────────────────
type BotType = "recording" | "voice_agent";

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

  // Recall sends "recording.done" when a recording is ready to be transcribed.
  // For voice_agent bots we use this to trigger AssemblyAI async transcription.
  if (payload?.event === "recording.done") {
    console.log(
      `[recall_webhook] recording.done received — bot_id="${payload?.data?.bot?.id}" recording_id="${payload?.data?.recording?.id}"`,
    );
    await handleRecordingDone(payload);
    return;
  }

  // Recall sends "transcript.failed" when async transcription fails (e.g. AssemblyAI rejection).
  if (payload?.event === "transcript.failed") {
    console.log(
      `[recall_webhook] transcript.failed received — bot_id="${payload?.data?.bot?.id}" transcript_id="${payload?.data?.transcript?.id}"`,
    );
    await handleTranscriptFailed(payload);
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

  const { data: meetingRow } = await supabase
    .from('meetings')
    .select('id, done, bot_type, calendar_event_id')
    .eq('bot_id', botId)
    .single();
  const meetingDbId = meetingRow?.id as string | undefined;

  const { data: meetingTagRows } = await supabase
    .from("meeting_tags")
    .select("tag_id, kb_tags(slug)")
    .eq("bot_id", botId);
  let kbTagIds = meetingTagRows?.map((r: any) => r.tag_id) ?? []; // eslint-disable-line @typescript-eslint/no-explicit-any
  let kbMeetingType = (meetingTagRows?.[0] as any)?.kb_tags?.slug ?? "toplanti"; // eslint-disable-line @typescript-eslint/no-explicit-any

  if (kbTagIds.length === 0 && meetingRow?.calendar_event_id) {
    const { data: calEventTagRow } = await supabase
      .from("calendar_event_tags")
      .select("tag_ids")
      .eq("calendar_event_id", meetingRow.calendar_event_id)
      .single();
    if (calEventTagRow?.tag_ids?.length) {
      await supabase.from("meeting_tags").upsert(
        calEventTagRow.tag_ids.map((tid: string) => ({
          bot_id: botId,
          tag_id: tid,
        })),
        { onConflict: "bot_id,tag_id", ignoreDuplicates: true }
      );
      kbTagIds = calEventTagRow.tag_ids;
      const { data: tagRows } = await supabase
        .from("kb_tags")
        .select("slug")
        .in("id", kbTagIds);
      kbMeetingType = (tagRows?.[0] as any)?.slug ?? "toplanti"; // eslint-disable-line @typescript-eslint/no-explicit-any
    }
  }

  if (meetingRow?.done === true) {
    console.log(`[handleBotDone] meeting already marked done for bot_id=${botId}, skipping`);
    return;
  }

  const inferredBotType: "voice_agent" | "recording" = meetingRow?.bot_type === "voice_agent"
    ? "voice_agent"
    : "recording";

  console.log(
    `[handleBotDone] ── START bot_id=${botId} ─────────────────────────────`,
  );

  // Step 1: Fetch bot details from Recall v1 API to get transcript download URLs
  let downloadUrls: string[] = [];
  let botName: string = "";
  let botMeetingUrl: string | null = null;
  let botData: any = null;
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

        const transcriptProvider = recordings[0]?.media_shortcuts?.transcript?.data?.provider ?? {};
        console.log(`[handleBotDone] transcript provider: ${JSON.stringify(transcriptProvider)}`);

        // All bots use recallai_streaming for real-time transcript.data during the call.
        // Recording bots: supplement from Recall native download_url here.
        // Voice agent bots: return early below — transcription handled by assembly_ai_async transcript.done.
        downloadUrls = recordings
          .map((r: any, i: number) => {
            const transcriptShortcut = r?.media_shortcuts?.transcript?.data;
            const url = transcriptShortcut?.download_url ?? null;
            console.log(`[handleBotDone] recordings[${i}] transcript url: ${url ?? "NONE"}`);
            return url;
          })
          .filter((u: string | null): u is string => !!u);

      console.log(
        `[handleBotDone] transcript URLs found: ${downloadUrls.length} / ${recordings.length} recordings`,
      );

      // Backfill meeting_url, bot_type, and bot_name — important for calendar-scheduled bots
      // where these fields weren't available when the meetings row was first created.
      // Zoom returns meeting_url as an object; only use string values for matching/storage.
      botMeetingUrl = typeof botData?.meeting_url === "string" ? botData.meeting_url : null;
      botName = botData?.bot_name ?? "";
      // Use the moment the bot entered in_call_recording as the meeting start anchor.
      meetingStartIso =
        (botData?.status_changes as any[] | undefined)?.find(
          (s: any) => s.code === "in_call_recording",
        )?.created_at ?? null;
      try {
        const backfillUpdate: Record<string, any> = {
          bot_type: inferredBotType,
          bot_name: botName || null,
        };
        // Only overwrite meeting_url when the API returns a plain string (not Zoom's object shape)
        if (botMeetingUrl) backfillUpdate.meeting_url = botMeetingUrl;
        await supabase
          .from("meetings")
          .update(backfillUpdate)
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

  if (inferredBotType === "voice_agent") {
    console.log(`[handleBotDone] voice_agent bot — transcript will arrive via assembly_ai_async transcript.done, skipping download`);
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
    await upsertIngestionLog(botId, null, "skipped",
      { error_message: "No transcript download URL from Recall" });
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

        // Handle transcript formats:
        // - Recall diarized: top-level array of segments
        // - AssemblyAI flat: { utterances: [{ speaker, words }] }
        // - AssemblyAI async_chunked: { parts: [{ utterances: [{ speaker, words }] }] }
        let incoming: TranscriptSegment[] = [];
        if (Array.isArray(rawJson)) {
          incoming = rawJson as TranscriptSegment[];
        } else if (rawJson && typeof rawJson === "object") {
          const obj = rawJson as any;
          if (Array.isArray(obj.utterances)) {
            incoming = obj.utterances.map((u: any) => ({
              speaker: u.speaker ?? "Unknown",
              words: u.words ?? [],
            }));
          } else if (Array.isArray(obj.parts)) {
            // AssemblyAI async_chunked: each part is an audio chunk with its own utterances
            incoming = obj.parts.flatMap((part: any) => {
              if (Array.isArray(part.utterances)) {
                return part.utterances.map((u: any) => ({
                  speaker: u.speaker ?? "Unknown",
                  words: u.words ?? [],
                }));
              }
              // Fallback: part itself is a segment
              return part.speaker !== undefined
                ? [{ speaker: part.speaker ?? "Unknown", words: part.words ?? [] }]
                : [];
            });
          } else {
            console.error(
              `[handleBotDone] unrecognised transcript shape:`,
              JSON.stringify(rawJson).slice(0, 300),
            );
          }
        }
        const speakers = [
          ...new Set(
            incoming.map((s) => s.participant?.name ?? s.speaker ?? "Unknown"),
          ),
        ];
        console.log(
          `[handleBotDone] transcript ${urlIndex + 1}: ${incoming.length} segments, speakers: ${JSON.stringify(speakers)}`,
        );
        segments.push(...incoming);
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
  // Voice agent bots return early above; only recording bots reach here.
  if (segments.length > 0) {
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

  // Step 5: Auto-ingest transcript into Knowledge Base (recording bots only — voice_agent
  // bots are handled in transcript_webhook.ts after the AssemblyAI diarized result arrives)
  try {
    await upsertIngestionLog(botId, null, "processing");

    const { data: allUtterances } = await supabase
      .from("utterances")
      .select("speaker, words, timestamp")
      .eq("bot_id", botId)
      .order("timestamp", { ascending: true });

    if (!allUtterances || allUtterances.length === 0) {
      await upsertIngestionLog(botId, null, "skipped",
        { error_message: "No utterances in DB for this bot" });
      console.log(`[handleBotDone] No utterances for bot ${botId} — skipping KB ingest`);
    } else {
      const transcriptText = allUtterances
        .map((row) => {
          const text = Array.isArray(row.words)
            ? row.words.map((w: any) => w.text).join(" ") // eslint-disable-line @typescript-eslint/no-explicit-any
            : "";
          return `${row.speaker}: ${text}`;
        })
        .join("\n");

      const participants = [...new Set(allUtterances.map((r) => r.speaker))].filter(
        (name) => name !== "WEYA Voice Agent" && name !== "WEYA by Light Eagle" && name !== "Unknown",
      );
      const meetingDate = new Date(allUtterances[0].timestamp);
      const dateStr = meetingDate.toLocaleDateString("tr-TR", {
        year: "numeric", month: "long", day: "numeric", weekday: "long",
      });

      let calendarTitle = "Toplantı";
      try {
        const metaMap = await buildBotMetadataMap([botId]);
        const meta = metaMap.get(botId);
        if (meta?.title) calendarTitle = meta.title;
      } catch (metaErr) {
        console.error(`[handleBotDone] Failed to get calendar title for KB ingest:`, metaErr);
      }

      const docTitle = participants.length > 0
        ? `${calendarTitle} — ${dateStr} — ${participants.join(", ")}`
        : `${calendarTitle} — ${dateStr}`;

      const result = await ingestTranscriptToKB({
        botId,
        transcriptText,
        docTitle,
        meetingDate,
        meetingType: kbMeetingType,
        calendarTitle,
        tagIds: kbTagIds,
      });

      if (result.skipped) {
        console.log(`[handleBotDone] KB ingest skipped: ${result.reason}`);
      } else {
        console.log(`[handleBotDone] ✅ KB ingested: "${docTitle}" (${result.chunkCount} chunks, ${transcriptText.length} chars)`);
      }
    }
  } catch (kbErr) {
    // KB ingest failure must NEVER break the webhook — Recall expects 200
    await upsertIngestionLog(botId, null, "failed", { error_message: String(kbErr) });
    console.error(`[handleBotDone] KB auto-ingest failed (non-fatal):`, kbErr);
  }

  console.log(
    `[handleBotDone] ── END bot_id=${botId} ───────────────────────────────`,
  );
}

export async function kb_retry_ingestion(args: { botId: string }): Promise<{ status: string }> {
  const { botId } = z.object({ botId: z.string().min(1) }).parse(args);

  const { data: log } = await supabase
    .from("kb_ingestion_log")
    .select("status")
    .eq("bot_id", botId)
    .maybeSingle();

  if (log?.status === "success") {
    throw new Error("Already successfully ingested — delete the KB document first to re-ingest");
  }

  await supabase.from("kb_ingestion_log").upsert(
    { bot_id: botId, status: "pending", error_message: null, updated_at: new Date().toISOString() },
    { onConflict: "bot_id" }
  );

  const fakePayload = { data: { bot: { id: botId } } };
  handleBotDone(fakePayload).catch((e) => {
    console.error(`[retry] handleBotDone failed for ${botId}:`, e);
  });

  return { status: "retry_triggered" };
}

/**
 * Handle recording.done webhook: for voice_agent bots, trigger AssemblyAI async transcription
 * on the recording so that a transcript.done event fires when diarization is complete.
 * Recording bots are not affected — their transcripts are already handled via bot.done.
 */
async function handleRecordingDone(body: any): Promise<void> {
  const botId: string | undefined = body?.data?.bot?.id;
  const recordingId: string | undefined = body?.data?.recording?.id;

  if (!botId || !recordingId) {
    console.error(
      `[recording.done] missing bot_id or recording_id — bot_id=${botId} recording_id=${recordingId}`,
    );
    return;
  }

  console.log(`[recording.done] bot_id=${botId} recording_id=${recordingId}`);

  const { data: meeting } = await supabase
    .from("meetings")
    .select("bot_type")
    .eq("bot_id", botId)
    .maybeSingle();

  if (meeting?.bot_type !== "voice_agent") {
    console.log(
      `[recording.done] bot_type=${meeting?.bot_type ?? "unknown"} — not a voice_agent bot, skipping AssemblyAI async trigger`,
    );
    return;
  }

  console.log(
    `[recording.done] voice_agent bot — triggering AssemblyAI async transcription for recording_id=${recordingId}`,
  );

  try {
    const createTranscriptRes = await fetch(
      `https://${env.RECALL_REGION}.recall.ai/api/v1/recording/${recordingId}/create_transcript/`,
      {
        method: "POST",
        headers: {
          Authorization: `${env.RECALL_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          provider: {
            assembly_ai_async: {
              language_code: "tr",
              speech_models: ["universal-2"],
            },
          },
        }),
      },
    );

    const responseText = await createTranscriptRes.text();
    if (createTranscriptRes.ok) {
      console.log(
        `[recording.done] AssemblyAI async transcript created — status=${createTranscriptRes.status} body=${responseText.slice(0, 200)}`,
      );
    } else {
      console.error(
        `[recording.done] create_transcript failed — status=${createTranscriptRes.status} body=${responseText.slice(0, 200)}`,
      );
    }
  } catch (err) {
    console.error(`[recording.done] unexpected error triggering AssemblyAI:`, err);
  }
}

/**
 * Handle transcript.failed webhook: fired when async transcription (e.g. AssemblyAI) fails.
 * If real-time utterances are already in the DB we mark done and keep them.
 * If there are no utterances we still mark done so the UI doesn't spin forever.
 */
async function handleTranscriptFailed(body: any): Promise<void> {
  const botId: string | undefined = body?.data?.bot?.id;
  const transcriptId: string | undefined = body?.data?.transcript?.id;
  const subCode: string | undefined = body?.data?.data?.sub_code;

  console.log(
    `[transcript.failed] bot_id=${botId} transcript_id=${transcriptId} sub_code=${subCode ?? "none"}`,
  );

  if (!botId) {
    console.error(`[transcript.failed] missing bot_id — cannot proceed`);
    return;
  }

  const { data: meeting } = await supabase
    .from("meetings")
    .select("done, bot_type")
    .eq("bot_id", botId)
    .maybeSingle();

  if (meeting?.done === true) {
    console.log(`[transcript.failed] meeting already done for bot_id=${botId} — skipping`);
    return;
  }

  const { count } = await supabase
    .from("utterances")
    .select("id", { count: "exact", head: true })
    .eq("bot_id", botId);

  const utteranceCount = count ?? 0;

  if (utteranceCount > 0) {
    console.log(
      `[transcript.failed] ${utteranceCount} real-time utterances already in DB — marking done`,
    );
  } else {
    console.log(
      `[transcript.failed] no utterances in DB — transcript failed with no fallback`,
    );
  }

  const { error } = await supabase
    .from("meetings")
    .update({ done: true })
    .eq("bot_id", botId);

  if (error) {
    console.error(`[transcript.failed] failed to mark done for bot_id=${botId}:`, error);
  } else {
    console.log(`[transcript.failed] marked done=true for bot_id=${botId}`);
  }
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
            recallai_streaming: {
              language: "tr",
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
              bot_type,
              attendee_emails: attendeeEmails,
              meeting_start_time: calendar_event.start_time ?? null,
              meeting_title: calendar_event.raw?.summary ?? calendar_event.raw?.subject ?? null,
              calendar_event_id: calendar_event.id,
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
