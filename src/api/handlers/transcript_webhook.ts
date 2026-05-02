import { supabase } from "../config/supabase";
import { buildBotMetadataMap } from "./notes";
import { normalizeMeetingType, upsertIngestionLog, ingestTranscriptToKB } from "./kb_ingest";

/**
 * Handle POST /api/webhooks/transcript
 * Receives transcript events from Recall.ai realtime endpoints.
 */
export async function handleTranscriptWebhook(
  body: any,
): Promise<{ status: number }> {
  const event = body?.event;
  const botId = body?.data?.bot?.id;

  if (!botId) {
    console.log(
      "Transcript webhook received without bot_id:",
      JSON.stringify(body),
    );
    return { status: 400 };
  }

  if (event === "transcript.data") {
    const rawData = body?.data?.data;
    const words = rawData?.words ?? [];
    const rawSpeaker: string = rawData?.participant?.name ?? "";
    const isFallback = !rawSpeaker || rawSpeaker === "Unknown";

    let speaker = rawSpeaker || "Unknown";
    if (isFallback) {
      // Bot's own audio arrives with a null/empty/Unknown participant name.
      // Look up the bot_name we stored when this bot was created.
      const { data: meeting } = await supabase
        .from("meetings")
        .select("bot_name")
        .eq("bot_id", botId)
        .maybeSingle();
      speaker = meeting?.bot_name || "WEYA Voice Agent";
      console.log(
        `Speaker resolved via bot_name fallback: "${speaker}" (raw was "${rawSpeaker}")`,
      );
    }

    console.log("Parsed webhook:", {
      event,
      botId,
      speaker,
      wordCount: words.length,
    });

    // Step 1: upsert meeting row — independent of utterance insert
    try {
      const { data: meetingData, error: meetingError } = await supabase
        .from("meetings")
        .upsert(
          { bot_id: botId, done: false },
          { onConflict: "bot_id", ignoreDuplicates: true },
        );

      if (meetingError) {
        console.error("Supabase meetings upsert failed:", {
          bot_id: botId,
          event,
          error: meetingError,
        });
      } else {
        console.log("Supabase meetings upsert ok:", {
          bot_id: botId,
          data: meetingData,
        });
      }
    } catch (err) {
      console.error("Unexpected error in meetings upsert:", {
        bot_id: botId,
        event,
        err,
      });
    }

    // Step 2: insert utterance — runs regardless of step 1 outcome
    try {
      const { data: utteranceData, error: utteranceError } = await supabase
        .from("utterances")
        .upsert(
          { bot_id: botId, speaker, words, timestamp: new Date().toISOString() },
          { onConflict: 'bot_id,speaker,timestamp', ignoreDuplicates: true },
        );

      if (utteranceError) {
        console.error("Supabase utterances insert failed:", {
          bot_id: botId,
          event,
          error: utteranceError,
          raw_data: rawData,
        });
      } else {
        console.log("Supabase utterances insert ok:", {
          bot_id: botId,
          speaker,
          wordCount: words.length,
          data: utteranceData,
        });
      }
    } catch (err) {
      console.error("Unexpected error in utterances insert:", {
        bot_id: botId,
        event,
        err,
        raw_data: rawData,
      });
    }

    // Always return 200 — Recall must not retry transcript.data events on DB failures
    return { status: 200 };
  }

  if (event === "transcript.done") {
    try {
      const transcriptId: string | undefined = body?.data?.transcript?.id;
      if (!transcriptId) {
        console.error(
          `[transcript_webhook] transcript.done missing transcript_id — body=${JSON.stringify(body).slice(0, 200)}`,
        );
        return { status: 200 };
      }

      const recallApiKey = process.env.RECALL_API_KEY;
      const recallRegion = process.env.RECALL_REGION || "api";

      // Fetch the transcript object to determine the provider (recallai_streaming vs assembly_ai_async)
      const transcriptRes = await fetch(
        `https://${recallRegion}.recall.ai/api/v1/transcript/${transcriptId}/`,
        { headers: { Authorization: `${recallApiKey}`, "Content-Type": "application/json" } },
      );

      if (!transcriptRes.ok) {
        console.error(`[transcript_webhook] transcript fetch failed: ${transcriptRes.status} transcript_id=${transcriptId}`);
        return { status: 200 };
      }

      const transcriptObj = await transcriptRes.json();
      const provider = transcriptObj?.provider ?? {};
      const isRecallaiStreaming = "recallai_streaming" in (provider as object);
      const isAssemblyAiAsync = "assembly_ai_async" in (provider as object);

      console.log(
        `[transcript_webhook] transcript.done transcript_id=${transcriptId} bot_id=${botId} provider=${JSON.stringify(provider)}`,
      );

      // ── CASE A: recallai_streaming ────────────────────────────────────────────
      // Real-time utterances are authoritative for recording bots.
      // Voice agent bots skip this — they wait for their assembly_ai_async transcript.done.
      if (isRecallaiStreaming) {
        const { data: meetingRow } = await supabase
          .from("meetings")
          .select("bot_type")
          .eq("bot_id", botId)
          .maybeSingle();

        if (meetingRow?.bot_type === "voice_agent") {
          console.log(
            `[transcript_webhook] recallai_streaming for voice_agent bot — skipping, waiting for assembly_ai_async transcript.done`,
          );
          return { status: 200 };
        }

        // Recording bot: handleBotDone (triggered by bot.done) handles transcript download and done marking.
        // transcript.done for recallai_streaming is a no-op here — same as previous behavior.
        console.log(
          `[transcript_webhook] recallai_streaming for recording bot — no-op, handleBotDone is authoritative`,
        );
        return { status: 200 };
      }

      // ── CASE B: assembly_ai_async ─────────────────────────────────────────────
      // AssemblyAI diarized result for a voice_agent bot.
      // Download, parse, replace real-time utterances, and mark done.
      if (isAssemblyAiAsync) {
        console.log(
          `[transcript.done/assemblyai] processing transcript_id=${transcriptId} for bot_id=${botId}`,
        );

        const downloadUrl: string | undefined = transcriptObj?.data?.download_url;
        if (!downloadUrl) {
          console.error(
            `[transcript.done/assemblyai] no download_url in transcript object — transcript_id=${transcriptId}`,
          );
        } else {
          try {
            const dlRes = await fetch(downloadUrl);
            if (!dlRes.ok) {
              console.error(
                `[transcript.done/assemblyai] download failed (${dlRes.status}): ${downloadUrl.slice(0, 80)}`,
              );
            } else {
              const rawText = await dlRes.text();
              console.log(`[transcript.done/assemblyai] downloaded (first 300 chars): ${rawText.slice(0, 300)}`);

              let rawJson: unknown = null;
              try {
                rawJson = JSON.parse(rawText);
              } catch (e) {
                console.error(`[transcript.done/assemblyai] JSON parse failed:`, e);
              }

              type Segment = { speaker: string; words: unknown[] };
              let segments: Segment[] = [];
              let formatDetected = "none";

              if (rawJson && typeof rawJson === "object") {
                const obj = rawJson as any;
                if (Array.isArray(obj.utterances) && obj.utterances.length > 0) {
                  // AssemblyAI native: { utterances: [{ speaker, text, start, end }] }
                  formatDetected = "assemblyai_utterances";
                  segments = obj.utterances.map((u: any) => ({
                    speaker: u.speaker ?? "Unknown",
                    words: [{
                      text: u.text ?? "",
                      start_timestamp: { absolute: (u.start ?? 0) / 1000 },
                      end_timestamp: { absolute: (u.end ?? 0) / 1000 },
                    }],
                  }));
                } else if (Array.isArray(obj.parts)) {
                  // Recall-wrapped AssemblyAI: { parts: [{ utterances, words }] }
                  formatDetected = "recall_wrapped_parts";
                  segments = obj.parts.flatMap((part: any) => {
                    if (Array.isArray(part.utterances)) {
                      return part.utterances.map((u: any) => ({
                        speaker: u.speaker ?? "Unknown",
                        words: u.words ?? [],
                      }));
                    }
                    return part.speaker !== undefined
                      ? [{ speaker: part.speaker ?? "Unknown", words: part.words ?? [] }]
                      : [];
                  });
                } else if (Array.isArray(rawJson)) {
                  // Recall native diarized format: [{ participant: { name }, words: [...] }]
                  formatDetected = "recall_native_array";
                  segments = (rawJson as any[]).map((seg: any) => ({
                    speaker: seg.participant?.name ?? seg.speaker ?? "Unknown",
                    words: seg.words ?? [],
                  }));
                }
              }

              console.log(
                `[transcript.done/assemblyai] format=${formatDetected} segments=${segments.length}`,
              );

              if (segments.length === 0) {
                console.error(
                  `[transcript.done/assemblyai] 0 segments for bot_id=${botId} — raw shape: ${JSON.stringify(rawJson).slice(0, 200)}`,
                );
              } else {
                // Speaker mapping: single uppercase letter → human caller / bot, named string → as-is
                // In AssemblyAI output, "A" is the first speaker chronologically.
                // For voice agent calls the human speaks first, so "A" = human, others = bot.
                const { data: meetingMeta } = await supabase
                  .from("meetings")
                  .select("attendee_emails")
                  .eq("bot_id", botId)
                  .maybeSingle();
                const attendeeEmails: string[] = Array.isArray(meetingMeta?.attendee_emails)
                  ? (meetingMeta.attendee_emails as string[])
                  : [];
                const humanSpeakerName = attendeeEmails[0] ?? "Participant";

                const now = Date.now();
                const rows = segments.map((seg, index) => {
                  const raw = seg.speaker ?? "";
                  let speaker: string;
                  if (/^[A-Z]$/.test(raw)) {
                    // Generic AssemblyAI label: "A" = human caller, anything else = bot turns
                    speaker = raw === "A" ? humanSpeakerName : "WEYA Voice Agent";
                  } else {
                    speaker = raw || "Unknown";
                  }
                  return {
                    bot_id: botId,
                    speaker,
                    words: seg.words,
                    source: "assemblyai",
                    timestamp: new Date(now + index).toISOString(),
                  };
                });
                const speakers = [...new Set(rows.map((r) => r.speaker))];

                const { count: existingCount } = await supabase
                  .from("utterances")
                  .select("id", { count: "exact", head: true })
                  .eq("bot_id", botId);
                console.log(
                  `[transcript.done/assemblyai] deleting ${existingCount ?? 0} existing utterances for bot_id=${botId}`,
                );

                await supabase.from("utterances").delete().eq("bot_id", botId);
                const { error: insErr, data: insData } = await supabase
                  .from("utterances")
                  .insert(rows)
                  .select("id");
                if (insErr) {
                  console.error(
                    `[transcript.done/assemblyai] insert failed for bot_id=${botId}:`,
                    insErr,
                  );
                } else {
                  console.log(
                    `[transcript.done/assemblyai] inserted ${insData?.length ?? rows.length} utterances for bot_id=${botId}, speakers=${JSON.stringify(speakers)}`,
                  );

                  // Step 5: Auto-ingest diarized transcript into KB (voice_agent bots)
                  // Runs after AssemblyAI utterances are written so we get the high-quality
                  // diarized content, not the lower-quality real-time streaming transcript.
                  try {
                    await upsertIngestionLog(botId, null, "processing");

                    const transcriptText = rows
                      .map((r) => {
                        const text = Array.isArray(r.words)
                          ? (r.words as any[]).map((w) => w.text ?? "").join(" ") // eslint-disable-line @typescript-eslint/no-explicit-any
                          : "";
                        return `${r.speaker}: ${text}`;
                      })
                      .join("\n");

                    const participants = [...new Set(rows.map((r) => r.speaker))]
                      .filter((name) => name !== "WEYA Voice Agent" && name !== "Unknown");

                    const meetingDate = new Date(now);
                    const dateStr = meetingDate.toLocaleDateString("tr-TR", {
                      year: "numeric", month: "long", day: "numeric", weekday: "long",
                    });

                    let calendarTitle = "Toplantı";
                    try {
                      const metaMap = await buildBotMetadataMap([botId]);
                      const meta = metaMap.get(botId);
                      if (meta?.title) calendarTitle = meta.title;
                    } catch (metaErr) {
                      console.error(`[transcript.done/assemblyai] Failed to get calendar title:`, metaErr);
                    }

                    const meetingType = normalizeMeetingType(calendarTitle);
                    const docTitle = participants.length > 0
                      ? `${calendarTitle} — ${dateStr} — ${participants.join(", ")}`
                      : `${calendarTitle} — ${dateStr}`;

                    // Fix 1: look up meeting_tags (written by handleBotDone earlier) for tagIds + slug
                    let kbTagIds: string[] = [];
                    let kbMeetingType = meetingType;
                    try {
                      const { data: meetingIdRow } = await supabase
                        .from("meetings").select("id").eq("bot_id", botId).single();
                      const meetingDbId = meetingIdRow?.id;
                      if (meetingDbId) {
                        const { data: meetingTagRows } = await supabase
                          .from("meeting_tags")
                          .select("tag_id, kb_tags(slug)")
                          .eq("meeting_id", meetingDbId);
                        if (meetingTagRows?.length) {
                          kbTagIds = meetingTagRows.map((r: any) => r.tag_id); // eslint-disable-line @typescript-eslint/no-explicit-any
                          kbMeetingType = (meetingTagRows[0] as any)?.kb_tags?.slug ?? "toplanti"; // eslint-disable-line @typescript-eslint/no-explicit-any
                        }
                      }
                    } catch {}

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
                      console.log(`[transcript.done/assemblyai] KB ingest skipped: ${result.reason}`);
                    } else {
                      console.log(`[transcript.done/assemblyai] ✅ KB ingested: "${docTitle}" (${result.chunkCount} chunks)`);
                    }
                  } catch (kbErr) {
                    await upsertIngestionLog(botId, null, "failed", { error_message: String(kbErr) });
                    console.error(`[transcript.done/assemblyai] KB ingest failed (non-fatal):`, kbErr);
                  }
                }
              }
            }
          } catch (dlErr) {
            console.error(`[transcript.done/assemblyai] download/parse error:`, dlErr);
          }
        }

        // Mark meeting done regardless of download outcome
        const { error: doneErr } = await supabase
          .from("meetings")
          .update({ done: true })
          .eq("bot_id", botId);
        if (doneErr) {
          console.error(`[transcript.done/assemblyai] failed to mark done for bot_id=${botId}:`, doneErr);
        } else {
          console.log(`[transcript.done/assemblyai] marked done=true for bot_id=${botId}`);
        }

        return { status: 200 };
      }

      // Unknown provider — log and fall through to the done mark below
      console.warn(
        `[transcript_webhook] transcript.done with unknown provider: ${JSON.stringify(provider)} — marking done and skipping`,
      );
    } catch (err) {
      console.error(`[transcript_webhook] error in transcript.done handler:`, err);
    }

    // Fallback done mark — reached only on unknown provider or unhandled exception
    try {
      const { error } = await supabase
        .from("meetings")
        .update({ done: true })
        .eq("bot_id", botId);
      if (error) {
        console.error("Supabase meetings update (done) failed:", { bot_id: botId, event, error });
      } else {
        console.log(`[transcript_webhook] marking done=true for bot_id=${botId} (fallback)`);
      }
    } catch (err) {
      console.error("Unexpected error marking transcript done:", { bot_id: botId, event, err });
    }

    return { status: 200 };
  }

  return { status: 200 };
}

/**
 * Handle GET /api/transcripts/:botId
 * Returns the stored transcript for a given bot.
 */
export async function handleGetTranscript(
  botId: string,
): Promise<{ utterances: any[]; done: boolean }> {
  // Fetch ALL utterances using pagination to avoid Supabase's default 1000-row limit.
  const PAGE_SIZE = 1000;
  let allUtteranceRows: { speaker: string; words: any; timestamp: string }[] = [];
  let offset = 0;
  let hasMore = true;

  while (hasMore) {
    const { data, error } = await supabase
      .from("utterances")
      .select("speaker, words, timestamp")
      .eq("bot_id", botId)
      .range(offset, offset + PAGE_SIZE - 1);

    if (error) {
      console.error(
        `Error fetching utterances for bot ${botId} (offset ${offset}):`,
        error,
      );
      throw error;
    }

    const rows = data ?? [];
    allUtteranceRows = allUtteranceRows.concat(rows);

    if (rows.length < PAGE_SIZE) {
      hasMore = false;
    } else {
      offset += PAGE_SIZE;
    }
  }

  const meetingResult = await supabase
    .from("meetings")
    .select("done")
    .eq("bot_id", botId)
    .maybeSingle();

  if (meetingResult.error) {
    console.error(
      `Error fetching meeting for bot ${botId}:`,
      meetingResult.error,
    );
    throw meetingResult.error;
  }

  // Sort by the first word's end_timestamp.absolute (actual speech time).
  // Fall back to row timestamp if words array is empty or the field is missing.
  const rows = allUtteranceRows;
  rows.sort((a, b) => {
    const aTime =
      (a.words as any[])?.[0]?.end_timestamp?.absolute ??
      new Date(a.timestamp).getTime() / 1000;
    const bTime =
      (b.words as any[])?.[0]?.end_timestamp?.absolute ??
      new Date(b.timestamp).getTime() / 1000;
    return aTime - bTime;
  });

  // Map DB column `speaker` back to `participant` to match the frontend's expected shape
  const utterances = rows.map((row) => ({
    participant: row.speaker,
    words: row.words,
    timestamp: row.timestamp,
  }));

  return {
    utterances,
    done: meetingResult.data?.done ?? false,
  };
}
