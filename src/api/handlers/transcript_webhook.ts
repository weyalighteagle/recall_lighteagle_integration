import { supabase } from "../config/supabase";

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
    // For voice_agent bots: download AssemblyAI transcript and store utterances.
    // This runs in addition to the bot.done path so whichever fires first with real
    // content wins. The delete+insert is idempotent — re-running just overwrites.
    try {
      const { data: meeting } = await supabase
        .from("meetings")
        .select("bot_type, bot_name")
        .eq("bot_id", botId)
        .single();

      const isVoiceAgent =
        meeting?.bot_type === "voice_agent" ||
        (meeting?.bot_name ?? "").toUpperCase().includes("WEYA VOICE") ||
        (meeting?.bot_name ?? "").toUpperCase().includes("VOICE AGENT");

      if (isVoiceAgent) {
        console.log(`[transcript_webhook] voice_agent transcript.done — fetching provider_data for bot ${botId}`);

        const recallApiKey = process.env.RECALL_API_KEY;
        const recallRegion = process.env.RECALL_REGION || "api";

        // Use the v1 bot API to get provider_data_download_url from media_shortcuts
        const botRes = await fetch(
          `https://${recallRegion}.recall.ai/api/v1/bot/${botId}/`,
          { headers: { Authorization: `${recallApiKey}`, "Content-Type": "application/json" } },
        );

        if (!botRes.ok) {
          console.error(`[transcript_webhook] v1 bot fetch failed: ${botRes.status}`);
        } else {
          const botData = await botRes.json();
          const botName: string = botData?.bot_name || "WEYA Voice Agent";
          const recordings: any[] = Array.isArray(botData?.recordings) ? botData.recordings : [];

          const providerUrls: string[] = recordings
            .map((r: any) => r?.media_shortcuts?.transcript?.data?.provider_data_download_url)
            .filter(Boolean);

          console.log(`[transcript_webhook] provider_data URLs found: ${providerUrls.length}`);

          let segments: { speaker: string; words: unknown[] }[] = [];

          for (const url of providerUrls) {
            try {
              const dlRes = await fetch(url);
              if (!dlRes.ok) {
                console.error(`[transcript_webhook] download failed (${dlRes.status}): ${url.slice(0, 80)}`);
                continue;
              }
              const rawText = await dlRes.text();
              console.log(`[transcript_webhook] provider_data (first 300 chars): ${rawText.slice(0, 300)}`);

              const json: unknown = JSON.parse(rawText);
              if (Array.isArray(json)) {
                segments.push(...(json as any[]));
              } else if (json && typeof json === "object") {
                const obj = json as any;
                if (Array.isArray(obj.utterances)) {
                  segments.push(...obj.utterances.map((u: any) => ({ speaker: u.speaker ?? "Unknown", words: u.words ?? [] })));
                } else if (Array.isArray(obj.parts)) {
                  segments.push(
                    ...obj.parts.flatMap((part: any) => {
                      if (Array.isArray(part.utterances)) {
                        return part.utterances.map((u: any) => ({ speaker: u.speaker ?? "Unknown", words: u.words ?? [] }));
                      }
                      return part.speaker !== undefined
                        ? [{ speaker: part.speaker ?? "Unknown", words: part.words ?? [] }]
                        : [];
                    }),
                  );
                } else {
                  console.error(`[transcript_webhook] unrecognised shape: ${rawText.slice(0, 200)}`);
                }
              }
            } catch (e) {
              console.error(`[transcript_webhook] error processing URL:`, e);
            }
          }

          console.log(`[transcript_webhook] parsed ${segments.length} segments`);

          if (segments.length > 0) {
            const rows = segments.map((seg) => {
              const raw = (seg as any).participant?.name ?? seg.speaker ?? "";
              const speaker = !raw || raw === "Unknown" ? botName : raw;
              return { bot_id: botId, speaker, words: seg.words, source: "assemblyai" };
            });
            const speakers = [...new Set(rows.map((r) => r.speaker))];
            await supabase.from("utterances").delete().eq("bot_id", botId);
            const { error: insErr, data: insData } = await supabase.from("utterances").insert(rows).select("id");
            if (insErr) {
              console.error(`[transcript_webhook] utterances insert failed for bot ${botId}:`, insErr);
            } else {
              console.log(`[transcript_webhook] inserted ${insData?.length ?? rows.length} utterances for bot ${botId}, speakers: ${JSON.stringify(speakers)}`);
            }
          } else {
            console.warn(`[transcript_webhook] 0 segments for voice_agent bot ${botId} — AssemblyAI returned empty content`);
          }
        }
      } else {
        console.log(`[transcript_webhook] not a voice_agent (bot_type=${meeting?.bot_type}, bot_name=${meeting?.bot_name}) — skipping provider_data fetch`);
      }
    } catch (err) {
      console.error(`[transcript_webhook] error in transcript.done handler:`, err);
    }

    // Mark done=true regardless of transcript outcome
    try {
      const { error } = await supabase
        .from("meetings")
        .update({ done: true })
        .eq("bot_id", botId);

      if (error) {
        console.error("Supabase meetings update (done) failed:", { bot_id: botId, event, error });
      } else {
        console.log(`[transcript_webhook] marking done=true for bot_id=${botId}`);
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
