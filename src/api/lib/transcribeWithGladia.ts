import { env } from "../config/env";
import { supabase } from "../config/supabase";

const POLL_INTERVAL_MS = 5_000;
const MAX_POLL_MS = 20 * 60 * 1_000; // 20 minutes

export type GladiaResult =
  | { ok: true; utteranceCount: number }
  | { ok: false; error: string };

export async function transcribeWithGladia(
  recordingUrl: string,
  botId: string,
  meetingStartIso: string | null,
  recallSegments?: any[],
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

    // Step 3b: Determine the absolute wall-clock anchor for Gladia's t=0.
    // Gladia times are seconds-from-recording-start (float).
    // We need an absolute wall-clock anchor to convert them.
    // Priority: Recall segment wall-clock > meeting scheduled start.
    let recordingStartMs: number | null = null;
    if (recallSegments && recallSegments.length > 0) {
      for (const seg of recallSegments) {
        const abs = (seg.words as any[])?.[0]?.start_timestamp?.absolute;
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
        `Cannot anchor Gladia timestamps: no Recall segments and no meeting start time. Bot ID: ${botId}`,
      );
    }

    // Build name intervals from Recall diarized segments (primary source).
    // Each interval maps an absolute [startMs, endMs] window to the speaker name Recall assigned.
    type NameInterval = { name: string; startMs: number; endMs: number };
    const nameIntervals: NameInterval[] = [];
    for (const seg of recallSegments ?? []) {
      const name: string = seg.participant?.name ?? seg.speaker ?? "";
      if (!name) continue;
      const words = seg.words as any[];
      const firstWord = words?.[0];
      const lastWord = words?.[words.length - 1];
      const startMs = firstWord?.start_timestamp?.absolute
        ? Date.parse(firstWord.start_timestamp.absolute) : null;
      const endMs = lastWord?.end_timestamp?.absolute
        ? Date.parse(lastWord.end_timestamp.absolute) : null;
      if (startMs !== null && endMs !== null && !isNaN(startMs) && !isNaN(endMs)) {
        nameIntervals.push({ name, startMs, endMs });
      }
    }
    const uniqueIntervalSpeakers = [...new Set(nameIntervals.map(i => i.name))];
    console.log(`[gladia] name intervals built: ${nameIntervals.length} segments from ${uniqueIntervalSpeakers.length} speakers`);

    // Step 3c: Resolve speaker per utterance by temporal overlap with Recall intervals.
    // Gladia's speaker index is ignored — Recall's diarization provides the names.
    function resolveSpeakerByTime(
      uStartMs: number,
      uEndMs: number,
      intervals: NameInterval[],
      textPreview?: string,
    ): string {
      let bestName = "Unknown Speaker";
      let bestOverlap = 0;
      for (const interval of intervals) {
        const overlap = Math.max(0,
          Math.min(uEndMs, interval.endMs) - Math.max(uStartMs, interval.startMs));
        if (overlap > bestOverlap) {
          bestOverlap = overlap;
          bestName = interval.name;
        }
      }
      if (bestOverlap === 0) {
        console.warn(`[gladia] no Recall overlap for utterance at ${new Date(uStartMs).toISOString()} (text: "${textPreview ?? ''}") — falling back to "Unknown Speaker"`);
      }
      return bestName;
    }

    // Step 3d: Map Gladia utterances to our schema using resolved speaker names.
    const gladiaRows = gladiaUtterances.map((utterance: any) => {
      const uStartMs = anchorMs + utterance.start * 1000;
      const uEndMs   = anchorMs + utterance.end   * 1000;
      const textPreview = (utterance.words ?? [])
        .slice(0, 5)
        .map((w: any) => w.word)
        .join(' ')
        .slice(0, 50);
      const speakerName = resolveSpeakerByTime(uStartMs, uEndMs, nameIntervals, textPreview);

      const hasWordLevel =
        Array.isArray(utterance.words) && utterance.words.length > 0;

      const words = hasWordLevel
        ? utterance.words.map((w: any) => ({
            text: w.word,
            start_timestamp: w.start,
            end_timestamp: w.end,
          }))
        : [{ text: utterance.transcription }];

      const timestamp = new Date(uStartMs).toISOString();

      return {
        bot_id: botId,
        speaker: speakerName,
        words,
        timestamp,
        source: "gladia",
      };
    });

    const speakerCounts: Record<string, number> = {};
    for (const row of gladiaRows) {
      speakerCounts[row.speaker] = (speakerCounts[row.speaker] ?? 0) + 1;
    }
    console.log(`[gladia] speaker assignments by time-overlap: ${JSON.stringify(speakerCounts)}`);

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
