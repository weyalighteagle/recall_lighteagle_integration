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
    // Only process transcript.done for assembly_ai_async_chunked bots.
    // recallai_streaming bots store utterances in real-time via transcript.data —
    // processing transcript.done for them would overwrite those with a redundant delete+insert.
    // We detect the provider from the Recall API directly to avoid a DB race with bot.done.
    try {
      const recallApiKey = process.env.RECALL_API_KEY;
      const recallRegion = process.env.RECALL_REGION || "api";

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

        // Detect provider from Recall API — recallai_streaming returns {"parts":[]} for provider_data
        // so checking URL existence is not enough; we must look at the provider field.
        const transcriptProvider = recordings[0]?.media_shortcuts?.transcript?.data?.provider ?? {};
        const isAssemblyAI = "assembly_ai_async_chunked" in (transcriptProvider as object);
        console.log(`[transcript_webhook] transcript.done bot="${botName}" provider=${JSON.stringify(transcriptProvider)} isAssemblyAI=${isAssemblyAI}`);

        if (!isAssemblyAI) {
          console.log(`[transcript_webhook] recallai_streaming bot — skipping transcript.done (real-time utterances are authoritative)`);
        } else {
        const providerUrls: string[] = recordings
          .map((r: any) => r?.media_shortcuts?.transcript?.data?.provider_data_download_url)
          .filter(Boolean);

        // Recall native diarized transcript — fallback if AssemblyAI returned empty parts
        const nativeUrls: string[] = recordings
          .map((r: any) => r?.media_shortcuts?.transcript?.data?.download_url)
          .filter(Boolean);

        console.log(`[transcript_webhook] AssemblyAI bot: provider_data_urls=${providerUrls.length} native_urls=${nativeUrls.length}`);

        if (providerUrls.length === 0 && nativeUrls.length === 0) {
          console.log(`[transcript_webhook] no transcript URLs — skipping`);
        } else {
          let segments: { speaker: string; words: unknown[] }[] = [];

          const parseJson = (rawText: string): { speaker: string; words: unknown[] }[] => {
            const json: unknown = JSON.parse(rawText);
            if (Array.isArray(json)) return json as any[];
            if (json && typeof json === "object") {
              const obj = json as any;
              if (Array.isArray(obj.utterances)) {
                return obj.utterances.map((u: any) => ({ speaker: u.speaker ?? "Unknown", words: u.words ?? [] }));
              }
              if (Array.isArray(obj.parts)) {
                return obj.parts.flatMap((part: any) => {
                  if (Array.isArray(part.utterances)) {
                    return part.utterances.map((u: any) => ({ speaker: u.speaker ?? "Unknown", words: u.words ?? [] }));
                  }
                  return part.speaker !== undefined ? [{ speaker: part.speaker ?? "Unknown", words: part.words ?? [] }] : [];
                });
              }
            }
            return [];
          };

          // Try AssemblyAI provider_data first
          for (const url of providerUrls) {
            try {
              const dlRes = await fetch(url);
              if (!dlRes.ok) { console.error(`[transcript_webhook] provider_data download failed (${dlRes.status})`); continue; }
              const rawText = await dlRes.text();
              console.log(`[transcript_webhook] provider_data (first 300 chars): ${rawText.slice(0, 300)}`);
              segments.push(...parseJson(rawText));
            } catch (e) { console.error(`[transcript_webhook] provider_data parse error:`, e); }
          }

          // Fall back to Recall native diarized transcript if AssemblyAI returned nothing
          if (segments.length === 0 && nativeUrls.length > 0) {
            console.log(`[transcript_webhook] AssemblyAI empty — falling back to Recall native transcript`);
            for (const url of nativeUrls) {
              try {
                const dlRes = await fetch(url);
                if (!dlRes.ok) { console.error(`[transcript_webhook] native download failed (${dlRes.status})`); continue; }
                const rawText = await dlRes.text();
                console.log(`[transcript_webhook] native transcript (first 300 chars): ${rawText.slice(0, 300)}`);
                segments.push(...parseJson(rawText));
              } catch (e) { console.error(`[transcript_webhook] native parse error:`, e); }
            }
          }

          console.log(`[transcript_webhook] parsed ${segments.length} segments`);

          if (segments.length > 0) {
            const source = segments.length > 0 && providerUrls.length > 0 ? "assemblyai" : "recall_native";
            const rows = segments.map((seg) => {
              const raw = (seg as any).participant?.name ?? seg.speaker ?? "";
              const speaker = !raw || raw === "Unknown" ? botName : raw;
              return { bot_id: botId, speaker, words: seg.words, source };
            });
            const speakers = [...new Set(rows.map((r) => r.speaker))];
            await supabase.from("utterances").delete().eq("bot_id", botId);
            const { error: insErr, data: insData } = await supabase.from("utterances").insert(rows).select("id");
            if (insErr) {
              console.error(`[transcript_webhook] utterances insert failed for bot ${botId}:`, insErr);
            } else {
              console.log(`[transcript_webhook] inserted ${insData?.length ?? rows.length} utterances for bot ${botId} (source=${source}), speakers: ${JSON.stringify(speakers)}`);
            }
          } else {
            console.warn(`[transcript_webhook] 0 segments for bot ${botId} — both AssemblyAI and Recall native returned empty`);
          }
        }
        } // end isAssemblyAI else
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
