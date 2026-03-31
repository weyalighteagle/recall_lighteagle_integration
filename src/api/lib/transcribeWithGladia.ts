import { env } from "../config/env";
import { supabase } from "../config/supabase";

const POLL_INTERVAL_MS = 5_000;
const MAX_POLL_MS = 20 * 60 * 1_000; // 20 minutes

export async function transcribeWithGladia(
  recordingUrl: string,
  botId: string,
  botName: string,
): Promise<void> {
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
    const { data: realtimeUtterances } = await supabase
      .from("utterances")
      .select("speaker, words")
      .eq("bot_id", botId)
      .order("timestamp", { ascending: true });

    // Step 3b: Find recording start time from the earliest absolute word timestamp.
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

    // Step 3c: Build speakerMap: Gladia index → real speaker name.
    const speakerMap: Record<string, string> = {};
    if (recordingStartMs !== null && realtimeUtterances && realtimeUtterances.length > 0) {
      const uniqueIndices = [...new Set(gladiaUtterances.map((u: any) => String(u.speaker)))];

      // Separate agent utterances from human utterances so they don't
      // cross-contaminate the proximity matching.
      const agentUtterances = realtimeUtterances.filter(
        (u) => u.speaker === botName,
      );
      const humanUtterances = realtimeUtterances.filter(
        (u) => u.speaker !== botName,
      );

      // Pre-pass: identify which Gladia speaker index belongs to the bot agent.
      // For each unique index we compute the minimum delta across ALL of its
      // utterances against ALL agent real-time utterances.  The index with the
      // globally smallest minimum delta is assigned to botName.
      if (agentUtterances.length > 0) {
        const agentTimestampsMs: number[] = agentUtterances
          .flatMap((u) => (u.words as any[]) ?? [])
          .map((w: any) => w?.start_timestamp?.absolute)
          .filter(Boolean)
          .map((abs: string) => new Date(abs).getTime());

        let agentIdx: string | null = null;
        let agentBestDelta = Infinity;

        for (const idx of uniqueIndices) {
          const idxUtterances = gladiaUtterances.filter(
            (u: any) => String(u.speaker) === idx,
          );

          for (const gu of idxUtterances) {
            const gladiaAbsMs = recordingStartMs + gu.start * 1000;
            for (const agentMs of agentTimestampsMs) {
              const delta = Math.abs(gladiaAbsMs - agentMs);
              if (delta < agentBestDelta) {
                agentBestDelta = delta;
                agentIdx = idx;
              }
            }
          }
        }

        if (agentIdx !== null) {
          speakerMap[agentIdx] = botName;
          console.log(
            `[gladia] agent index=${agentIdx} → "${botName}" (best delta ${agentBestDelta}ms)`,
          );
        }
      }

      // Human resolution: skip any index already resolved (the agent's index),
      // and only match against human real-time utterances.
      for (const idx of uniqueIndices) {
        if (speakerMap[idx]) continue;

        const sample = gladiaUtterances.find((u: any) => String(u.speaker) === idx);
        if (!sample) continue;

        const gladiaAbsMs = recordingStartMs + sample.start * 1000;

        // Find the human real-time utterance whose first word's absolute
        // timestamp is closest to this Gladia utterance's absolute start time.
        let bestName: string | null = null;
        let bestDelta = Infinity;

        for (const rt of humanUtterances) {
          const abs = (rt.words as any[])?.[0]?.start_timestamp?.absolute;
          if (!abs) continue;
          const delta = Math.abs(new Date(abs).getTime() - gladiaAbsMs);
          if (delta < bestDelta) {
            bestDelta = delta;
            bestName = rt.speaker as string;
          }
        }

        if (bestName) {
          speakerMap[idx] = bestName;
        }
      }
    }
    console.log(`[gladia] speakerMap: ${JSON.stringify(speakerMap)}`);

    // Step 3d: Map Gladia utterances to our schema using resolved speaker names.
    const rows = gladiaUtterances.map((utterance: any) => {
      const speakerIdx = String(utterance.speaker);
      const resolvedSpeaker = speakerMap[speakerIdx] ?? utterance.speaker;

      const hasWordLevel =
        Array.isArray(utterance.words) && utterance.words.length > 0;

      const words = hasWordLevel
        ? utterance.words.map((w: any) => ({
            text: w.word,
            start_timestamp: w.start,
            end_timestamp: w.end,
          }))
        : [{ text: utterance.transcription }];

      // Compute absolute timestamp so utterances sort correctly in the UI.
      // Fall back to raw Gladia seconds if no recording start time is available.
      const timestamp =
        recordingStartMs !== null
          ? new Date(recordingStartMs + utterance.start * 1000).toISOString()
          : new Date(utterance.start * 1000).toISOString();

      return {
        bot_id: botId,
        speaker: resolvedSpeaker,
        words,
        timestamp,
      };
    });

    // Step 4: Replace existing utterances for this bot
    const { error: deleteError } = await supabase
      .from("utterances")
      .delete()
      .eq("bot_id", botId);

    if (deleteError) {
      throw new Error(
        `Supabase delete failed for bot ${botId}: ${deleteError.message}`,
      );
    }

    const { error: insertError } = await supabase
      .from("utterances")
      .insert(rows);

    if (insertError) {
      throw new Error(
        `Supabase insert failed for bot ${botId}: ${insertError.message}`,
      );
    }

    console.log(
      `[gladia] DONE bot_id=${botId} — ${rows.length} utterances written to Supabase`,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[gladia] ERROR bot_id=${botId} — ${message}`);
  }
}
