import { supabase } from "../config/supabase";
import { calendars_list } from "./calendars_list";
import { calendar_events_list } from "./calendar_events_list";
import { handleGetTranscript } from "./transcript_webhook";

/**
 * Build a map of bot_id → { title, participants } by cross-referencing
 * calendar events (from Recall API) with utterance speakers (from Supabase).
 *
 * This is used exclusively by the Notes page so we don't modify
 * the existing /api/transcripts endpoints that other modules depend on.
 */
export async function buildBotMetadataMap(botIds: string[]): Promise<
    Map<string, { title: string | null; participants: string[] }>
> {
    const meta = new Map<string, { title: string | null; participants: string[] }>();

    // Initialize every bot_id with defaults
    for (const id of botIds) {
        meta.set(id, { title: null, participants: [] });
    }

    // Run both enrichments in parallel for speed
    await Promise.all([
        enrichParticipants(botIds, meta),
        enrichTitles(botIds, meta),
    ]);

    return meta;
}

/**
 * Get unique speakers per bot_id from the utterances table.
 * We only need distinct speaker names, so 1000 rows is more than enough —
 * meetings rarely have more than a few dozen unique participants.
 */
async function enrichParticipants(
    botIds: string[],
    meta: Map<string, { title: string | null; participants: string[] }>,
): Promise<void> {
    const { data: utteranceRows } = await supabase
        .from("utterances")
        .select("bot_id, speaker")
        .in("bot_id", botIds)
        .limit(1000);

    if (!utteranceRows || utteranceRows.length === 0) return;

    const speakersByBot = new Map<string, Set<string>>();
    for (const row of utteranceRows) {
        if (!speakersByBot.has(row.bot_id)) {
            speakersByBot.set(row.bot_id, new Set());
        }
        speakersByBot.get(row.bot_id)!.add(row.speaker);
    }
    for (const [botId, speakers] of speakersByBot) {
        const entry = meta.get(botId);
        if (entry) {
            entry.participants = [...speakers];
        }
    }
}

/**
 * Get meeting titles from calendar events via Recall API.
 * Fetches all calendars, then fetches recent events from each calendar
 * in parallel. Cross-references bot_ids in the events to find titles.
 */
async function enrichTitles(
    botIds: string[],
    meta: Map<string, { title: string | null; participants: string[] }>,
): Promise<void> {
    try {
        const botIdSet = new Set(botIds);
        const { calendars } = await calendars_list({});

        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

        // Fetch events from all calendars in parallel
        const eventResults = await Promise.all(
            calendars.map(async (calendar) => {
                try {
                    // Fetch only the first page of events (most recent)
                    // to keep the response fast
                    const result = await calendar_events_list({
                        calendar_id: calendar.id,
                        next: null,
                        start_time__gte: thirtyDaysAgo.toISOString(),
                        start_time__lte: null,
                    });
                    return result.calendar_events;
                } catch {
                    return [];
                }
            }),
        );

        // Flatten and cross-reference
        for (const events of eventResults) {
            for (const event of events) {
                for (const bot of event.bots ?? []) {
                    if (botIdSet.has(bot.bot_id)) {
                        const entry = meta.get(bot.bot_id);
                        if (entry) {
                            const title = event.raw?.summary ?? event.raw?.subject ?? null;
                            if (title) {
                                entry.title = title;
                            }
                        }
                    }
                }
            }
        }
    } catch (err) {
        // If calendar API fails, we still return meetings — just without titles
        console.error("Failed to fetch calendar events for notes enrichment:", err);
    }
}

/**
 * GET /api/notes
 * Returns all meetings enriched with calendar titles and participant names.
 */
export async function handleNotesList(): Promise<{
    meetings: {
        bot_id: string;
        bot_type: string | null;
        meeting_url: string | null;
        done: boolean;
        created_at: string;
        title: string | null;
        participants: string[];
    }[];
}> {
    // Fetch meetings (same grouping logic as /api/transcripts)
    const { data } = await supabase
        .from("meetings")
        .select("bot_id, bot_type, meeting_url, done, created_at")
        .order("created_at", { ascending: false });

    type Row = {
        bot_id: string;
        bot_type: string | null;
        meeting_url: string | null;
        done: boolean;
        created_at: string;
    };
    const rows: Row[] = data ?? [];
    const grouped = new Map<string, Row>();
    for (const row of rows) {
        const key = row.meeting_url ?? row.bot_id;
        const existing = grouped.get(key);
        if (!existing || row.bot_type === "voice_agent") {
            grouped.set(key, row);
        }
    }
    const meetings = [...grouped.values()];

    // Enrich with titles and participants
    const botIds = meetings.map((m) => m.bot_id);
    const metaMap = await buildBotMetadataMap(botIds);

    return {
        meetings: meetings.map((m) => {
            const enrichment = metaMap.get(m.bot_id);
            return {
                ...m,
                title: enrichment?.title ?? null,
                participants: enrichment?.participants ?? [],
            };
        }),
    };
}

/**
 * GET /api/notes/:botId
 * Returns the transcript for a bot, enriched with meeting title and participants.
 */
export async function handleNoteDetail(botId: string): Promise<{
    utterances: any[];
    done: boolean;
    title: string | null;
    participants: string[];
}> {
    // Get the base transcript data using the existing handler
    const transcript = await handleGetTranscript(botId);

    // Enrich with metadata
    const metaMap = await buildBotMetadataMap([botId]);
    const enrichment = metaMap.get(botId);

    return {
        ...transcript,
        title: enrichment?.title ?? null,
        participants: enrichment?.participants ?? [],
    };
}
