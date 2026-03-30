import { env } from "../config/env";
import { supabase } from "../config/supabase";

const POLL_INTERVAL_MS = 5_000;
const MAX_POLL_MS = 20 * 60 * 1_000; // 20 minutes

export async function transcribeWithGladia(
  recordingUrl: string,
  botId: string,
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

    // Step 3: Map Gladia utterances to our schema
    const gladiaUtterances: any[] =
      result?.result?.transcription?.utterances ?? [];

    const rows = gladiaUtterances.map((utterance: any) => {
      const hasWordLevel =
        Array.isArray(utterance.words) && utterance.words.length > 0;

      const words = hasWordLevel
        ? utterance.words.map((w: any) => ({
            text: w.word,
            start_timestamp: w.start,
            end_timestamp: w.end,
          }))
        : [{ text: utterance.transcription }];

      return {
        bot_id: botId,
        speaker: utterance.speaker,
        words,
        timestamp: new Date(utterance.start * 1000).toISOString(),
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
