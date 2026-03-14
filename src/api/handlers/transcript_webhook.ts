/**
 * In-memory transcript store: bot_id -> { utterances, done }
 * Note: Data is lost on server restart. For production persistence, replace with a database.
 */
const transcriptStore = new Map<string, { utterances: any[]; done: boolean }>();

/**
 * Handle POST /api/webhooks/transcript
 * Receives transcript events from Recall.ai realtime endpoints.
 */
export function handleTranscriptWebhook(body: any) {
    const event = body?.event;
    const botId = body?.data?.bot?.id;

    if (!botId) {
        console.log("Transcript webhook received without bot_id:", JSON.stringify(body));
        return { status: 400 };
    }

    if (event === "transcript.data") {
        const words = body?.data?.data?.words ?? [];
        const participant = body?.data?.data?.participant?.name ?? "Unknown";
        const entry = transcriptStore.get(botId) ?? { utterances: [], done: false };
        entry.utterances.push({
            participant,
            words,
            timestamp: new Date().toISOString(),
        });
        transcriptStore.set(botId, entry);
        console.log(`Transcript data received for bot ${botId}: ${words.length} words from ${participant}`);
    }

    if (event === "transcript.done") {
        const entry = transcriptStore.get(botId) ?? { utterances: [], done: false };
        entry.done = true;
        transcriptStore.set(botId, entry);
        console.log(`Transcript done for bot ${botId}`);
    }

    return { status: 200 };
}

/**
 * Handle GET /api/transcripts/:botId
 * Returns the stored transcript for a given bot.
 */
export function handleGetTranscript(botId: string) {
    const entry = transcriptStore.get(botId);
    return {
        utterances: entry?.utterances ?? [],
        done: entry?.done ?? false,
    };
}
