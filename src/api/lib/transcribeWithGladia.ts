import { env } from "../config/env";
import { supabase } from "../config/supabase";

const POLL_INTERVAL_MS = 5_000;
const MAX_POLL_MS = 20 * 60 * 1_000; // 20 minutes
// Nearest-neighbour speaker matching: reject any match further than this.
const SPEAKER_MAP_MAX_DELTA_MS = 60_000; // 60 seconds

export type GladiaResult =
  | { ok: true; utteranceCount: number }
  | { ok: false; error: string };

export async function transcribeWithGladia(
  recordingUrl: string,
  botId: string,
  meetingStartIso: string | null,
): Promise<GladiaResult> {
  try {
    console.log(
      `[gladia] START bot_id=${botId} — submitting audio to Gladia`,
    );

    // Step 1: Submit transcription request
    const submitResponse = await fetch(
      "https://api.gladia.io/v2/transcription",
      {
        method: "POST",
        headers: {
          "x-gladia-key": env.GLADIA_API_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          audio_url: recordingUrl,
          language: "tr",
          diarization: true,
          custom_vocabulary: [
            "WEYA",
            "Heval",
            "Gülfem",
            "Yiğit",
            "Mehmet Cem",
            "Onur",
            "Vercel",
            "Clerk",
            "JWT",
            "GitHub",
            "TypeScript",
            "Supabase",
            "Railway",
            "Recall",
            "Light Eagle",
          ],
        }),
      },
    );

    if (!submitResponse.ok) {
      const errText = await submitResponse.text();
      throw new Error(
        `Gladia submit failed (${submitResponse.status}): ${errText}`,
      );
    }

    const submitData = await submitResponse.json();
    const resultUrl: string = submitData.result_url;
    const gladiaId: string = submitData.id;

    if (!resultUrl) {
      throw new Error(
        `Gladia response missing result_url: ${JSON.stringify(submitData)}`,
      );
    }

    console.log(`[gladia] submitted — id=${gladiaId}, polling result_url`);

    // Step 2: Poll until done or timeout
    const deadline = Date.now() + MAX_POLL_MS;
    let result: any = null;

    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));

      const pollResponse = await fetch(resultUrl, {
        headers: { "x-gladia-key": env.GLADIA_API_KEY },
      });

      if (!pollResponse.ok) {
        const errText = await pollResponse.text();
        throw new Error(
          `Gladia poll failed (${pollResponse.status}): ${errText}`,
        );
      }

      result = await pollResponse.json();
      console.log(`[gladia] polling... status=${result?.status}`);

      if (result?.status === "done") break;
      if (result?.status === "error") {
        throw new Error(
          `Gladia transcription error: ${JSON.stringify(result)}`,
        );
      }
    }

    if (result?.status !== "done") {
      throw new Error(
        `Gladia transcription timed out after 20 minutes for bot ${botId}`,
      );
    }

    const gladiaUtterances: any[] =
      result?.result?.transcription?.utterances ?? [];

    // Step 3a: Fetch real-time utterances to resolve speaker names.
    // Gladia returns numeric indices ("0", "1", "2") — we map them back to
    // real names (e.g. "Heval Söğüt", "WEYA Voice Agent") using the
    // real-time transcript.data rows that arrived during the meeting.
    const { data: realtimeUtterances, error: rtError } = await supabase
      .from("utterances")
      .select("speaker, words")
      .eq("bot_id", botId)
      .order("timestamp", { ascending: true });

    if (rtError) {
      throw new Error(
        `Failed to fetch real-time utterances for bot ${botId}: ${rtError.message}`,
      );
    }

    // Step 3b: Determine the absolute wall-clock anchor for Gladia's t=0.
    // Gladia times are seconds-from-recording-start (float).
    // We need an absolute wall-clock anchor to convert them.
    // Priority: real-time utterance wall-clock > meeting scheduled start.
    let recordingStartMs: number | null = null;
    if (realtimeUtterances && realtimeUtterances.length > 0) {
      for (const u of realtimeUtterances) {
        const abs = (u.words as any[])?.[0]?.start_timestamp?.absolute;
        if (abs) {
          const ms = new Date(abs).getTime();
          if (recordingStartMs === null || ms < recordingStartMs) {
            recordingStartMs = ms;
          }
        }
      }
    }

    let anchorMs: number;
    if (recordingStartMs !== null) {
      anchorMs = recordingStartMs;
    } else if (meetingStartIso !== null) {
      anchorMs = new Date(meetingStartIso).getTime();
    } else {
      throw new Error(
        `Cannot anchor Gladia timestamps: no real-time utterances and no meeting start time. Bot ID: ${botId}`,
      );
    }

    // Step 3c: Build speakerMap: Gladia index → real speaker name.
    // For each unique Gladia speaker index, find its absolute start time and
    // match it to the closest real-time utterance by wall-clock proximity.
    const speakerMap: Record<string, string> = {};
    if (realtimeUtterances && realtimeUtterances.length > 0) {
      const uniqueIndices = [
        ...new Set(gladiaUtterances.map((u: any) => String(u.speaker))),
      ];

      for (const idx of uniqueIndices) {
        const sample = gladiaUtterances.find(
          (u: any) => String(u.speaker) === idx,
        );
        if (!sample) continue;

        const gladiaAbsMs = anchorMs + sample.start * 1000;

        // Find the real-time utterance whose first word's absolute timestamp
        // is closest to this Gladia utterance's absolute start time.
        let bestName: string | null = null;
        let bestDelta = Infinity;

        for (const rt of realtimeUtterances) {
          const abs = (rt.words as any[])?.[0]?.start_timestamp?.absolute;
          if (!abs) continue;
          const delta = Math.abs(new Date(abs).getTime() - gladiaAbsMs);
          if (delta < bestDelta) {
            bestDelta = delta;
            bestName = rt.speaker as string;
          }
        }

        if (bestName && bestDelta <= SPEAKER_MAP_MAX_DELTA_MS) {
          speakerMap[idx] = bestName;
        } else {
          speakerMap[idx] = `Speaker ${idx}`;
          console.warn(
            `[gladia] speakerMap: no real-time anchor within ${SPEAKER_MAP_MAX_DELTA_MS}ms` +
              ` for Gladia speaker ${idx} (best delta: ${bestDelta}ms). Using fallback label.`,
          );
        }
      }
    }
    console.log(`[gladia] speakerMap: ${JSON.stringify(speakerMap)}`);

    // Step 3d: Map Gladia utterances to our schema using resolved speaker names.
    const gladiaRows = gladiaUtterances.map((utterance: any) => {
      const speakerIdx = String(utterance.speaker);
      const resolvedSpeaker = speakerMap[speakerIdx] ?? `Speaker ${speakerIdx}`;

      const hasWordLevel =
        Array.isArray(utterance.words) && utterance.words.length > 0;

      const words = hasWordLevel
        ? utterance.words.map((w: any) => ({
            text: w.word,
            start_timestamp: w.start,
            end_timestamp: w.end,
          }))
        : [{ text: utterance.transcription }];

      const timestamp = new Date(
        anchorMs + utterance.start * 1000,
      ).toISOString();

      return {
        bot_id: botId,
        speaker: resolvedSpeaker,
        words,
        timestamp,
        source: "gladia",
      };
    });

    // Step 4: Insert Gladia rows, then delete any non-Gladia rows for this bot.
    // The source filter makes this safe to run unconditionally — it never
    // touches the rows we just inserted.
    const { error: insertError } = await supabase
      .from("utterances")
      .upsert(gladiaRows, { onConflict: 'bot_id,speaker,timestamp', ignoreDuplicates: true });

    if (insertError) {
      throw new Error(
        `Gladia utterance insert failed for bot ${botId}: ${insertError.message}`,
      );
    }

    const { error: deleteError } = await supabase
      .from("utterances")
      .delete()
      .eq("bot_id", botId)
      .neq("source", "gladia");
    if (deleteError) {
      console.warn(
        `[gladia] cleanup delete warning for bot ${botId}: ${deleteError.message}`,
      );
    }

    console.log(
      `[gladia] DONE bot_id=${botId} — ${gladiaRows.length} utterances written to Supabase`,
    );
    return { ok: true, utteranceCount: gladiaRows.length };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[gladia] ERROR bot_id=${botId} — ${message}`);
    return { ok: false, error: message };
  }
}
