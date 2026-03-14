import { supabase } from "../config/supabase";

/**
 * Handle POST /api/webhooks/transcript
 * Receives transcript events from Recall.ai realtime endpoints.
 */
export async function handleTranscriptWebhook(body: any): Promise<{ status: number }> {
    const event = body?.event;
    const botId = body?.data?.bot?.id;

    if (!botId) {
        console.log("Transcript webhook received without bot_id:", JSON.stringify(body));
        return { status: 400 };
    }

    if (event === "transcript.data") {
        const words = body?.data?.data?.words ?? [];
        const speaker = body?.data?.data?.participant?.name ?? "Unknown";

        console.log("Parsed webhook:", { event, botId, speaker, words });

        // Upsert meeting row so we don't fail if it already exists
        const { data: meetingData, error: meetingError } = await supabase
            .from("meetings")
            .upsert({ bot_id: botId, done: false }, { onConflict: "bot_id", ignoreDuplicates: true });

        console.log("Supabase meetings upsert:", { data: meetingData, error: meetingError });

        if (meetingError) {
            console.error(`Error upserting meeting for bot ${botId}:`, meetingError);
            return { status: 500 };
        }

        // Insert utterance
        const { data: utteranceData, error: utteranceError } = await supabase
            .from("utterances")
            .insert({ bot_id: botId, speaker, words });

        console.log("Supabase utterances insert:", { data: utteranceData, error: utteranceError });

        if (utteranceError) {
            console.error(`Error inserting utterance for bot ${botId}:`, utteranceError);
            return { status: 500 };
        }

        console.log(`Transcript data received for bot ${botId}: ${words.length} words from ${speaker}`);
    }

    if (event === "transcript.done") {
        const { error } = await supabase
            .from("meetings")
            .update({ done: true })
            .eq("bot_id", botId);

        if (error) {
            console.error(`Error marking transcript done for bot ${botId}:`, error);
            return { status: 500 };
        }

        console.log(`Transcript done for bot ${botId}`);
    }

    return { status: 200 };
}

/**
 * Handle GET /api/transcripts/:botId
 * Returns the stored transcript for a given bot.
 */
export async function handleGetTranscript(botId: string): Promise<{ utterances: any[]; done: boolean }> {
    const [utterancesResult, meetingResult] = await Promise.all([
        supabase
            .from("utterances")
            .select("speaker, words, timestamp")
            .eq("bot_id", botId)
            .order("timestamp", { ascending: true }),
        supabase
            .from("meetings")
            .select("done")
            .eq("bot_id", botId)
            .maybeSingle(),
    ]);

    if (utterancesResult.error) {
        console.error(`Error fetching utterances for bot ${botId}:`, utterancesResult.error);
        throw utterancesResult.error;
    }

    if (meetingResult.error) {
        console.error(`Error fetching meeting for bot ${botId}:`, meetingResult.error);
        throw meetingResult.error;
    }

    // Map DB column `speaker` back to `participant` to match the frontend's expected shape
    const utterances = (utterancesResult.data ?? []).map((row) => ({
        participant: row.speaker,
        words: row.words,
        timestamp: row.timestamp,
    }));

    return {
        utterances,
        done: meetingResult.data?.done ?? false,
    };
}
