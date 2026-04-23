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
  speakerTimelineUrl?: string,
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

    // Fetch Recall speaker_timeline for primary speaker resolution (pre-signed S3, no auth needed)
    type TimelineEvent = { type: string; timestamp: number };
    type TimelineParticipant = { name: string; events: TimelineEvent[] };
    let timelineRaw: TimelineParticipant[] = [];
    if (speakerTimelineUrl) {
      try {
        const tlRes = await fetch(speakerTimelineUrl);
        if (tlRes.ok) {
          timelineRaw = await tlRes.json();
        } else {
          console.warn(`[gladia] speaker_timeline fetch failed (${tlRes.status}) — will fall back to real-time matching`);
        }
      } catch (tlErr) {
        console.warn(`[gladia] speaker_timeline fetch error — will fall back:`, tlErr);
      }
    }

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

    // Build timeline segments in absolute ms from Recall's speaker_timeline.
    // event.timestamp is seconds-from-recording-start, same coordinate as Gladia start/end.
    type TimelineSegment = { name: string; startMs: number; endMs: number };
    const timelineSegments: TimelineSegment[] = [];
    for (const participant of timelineRaw) {
      let speechStart: number | null = null;
      for (const ev of participant.events ?? []) {
        if (ev.type === 'speech_on') {
          speechStart = anchorMs + ev.timestamp * 1000;
        } else if (ev.type === 'speech_off' && speechStart !== null) {
          timelineSegments.push({ name: participant.name, startMs: speechStart, endMs: anchorMs + ev.timestamp * 1000 });
          speechStart = null;
        }
      }
    }
    const uniqueTimelineParticipants = [...new Set(timelineRaw.map(p => p.name))];
    console.log(`[gladia] speaker_timeline loaded: ${timelineSegments.length} speech segments for ${uniqueTimelineParticipants.length} participants`);

    // Step 3c: Build speakerMap with 3-level fallback chain.
    console.log(`[gladia] real-time utterances available: ${realtimeUtterances?.length ?? 0}`);
    const speakerMap: Record<string, string> = {};
    const uniqueIndices = [
      ...new Set(gladiaUtterances.map((u: any) => String(u.speaker))),
    ];

    // Level 1 — speaker_timeline (PRIMARY)
    // Iterate all utterances for each speaker index; take first midpoint that
    // lands inside a timeline segment (more robust than using only the first utterance).
    if (timelineSegments.length > 0) {
      const level1Resolved: Record<string, string> = {};
      for (const idx of uniqueIndices) {
        const utterancesForIdx = gladiaUtterances.filter((u: any) => String(u.speaker) === idx);
        for (const utterance of utterancesForIdx) {
          const midMs = anchorMs + utterance.start * 1000 + ((utterance.end - utterance.start) * 1000) / 2;
          const seg = timelineSegments.find(s => s.startMs <= midMs && midMs <= s.endMs);
          if (seg) {
            speakerMap[idx] = seg.name;
            level1Resolved[idx] = seg.name;
            break;
          }
        }
      }
      console.log(`[gladia] speakerMap via timeline: ${JSON.stringify(level1Resolved)}`);
    }

    // Level 2 — real-time utterances (SECONDARY)
    // Proximity-match against real-time rows for any index Level 1 did not resolve.
    const unresolvedAfterLevel1 = uniqueIndices.filter(idx => !(idx in speakerMap));
    if (unresolvedAfterLevel1.length > 0 && realtimeUtterances && realtimeUtterances.length > 0) {
      const level2Resolved: Record<string, string> = {};
      for (const idx of unresolvedAfterLevel1) {
        const sample = gladiaUtterances.find((u: any) => String(u.speaker) === idx);
        if (!sample) continue;
        const gladiaAbsMs = anchorMs + sample.start * 1000;
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
          level2Resolved[idx] = bestName;
        }
      }
      console.log(`[gladia] speakerMap via realtime fallback: ${JSON.stringify(level2Resolved)}`);
    }

    // Level 3 — "Speaker N" (LAST RESORT)
    for (const idx of uniqueIndices) {
      if (!(idx in speakerMap)) {
        speakerMap[idx] = `Speaker ${idx}`;
        console.warn(`[gladia] speakerMap: unresolved speaker idx ${idx} — using fallback label "Speaker ${idx}"`);
      }
    }

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
