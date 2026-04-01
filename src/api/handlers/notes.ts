import { supabase } from "../config/supabase";
import { calendars_list } from "./calendars_list";
import { calendar_events_list } from "./calendar_events_list";

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
 * Uses pagination to handle large numbers of bots/utterances.
 */
async function enrichParticipants(
    botIds: string[],
    meta: Map<string, { title: string | null; participants: string[] }>,
): Promise<void> {
    const PAGE_SIZE = 1000;
    let allRows: { bot_id: string; speaker: string }[] = [];
    let offset = 0;
    let hasMore = true;

    while (hasMore) {
        const { data } = await supabase
            .from("utterances")
            .select("bot_id, speaker")
            .in("bot_id", botIds)
            .range(offset, offset + PAGE_SIZE - 1);

        const rows = data ?? [];
        allRows = allRows.concat(rows);
        hasMore = rows.length === PAGE_SIZE;
        offset += PAGE_SIZE;
    }

    if (allRows.length === 0) return;

    const speakersByBot = new Map<string, Set<string>>();
    for (const row of allRows) {
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
 * When multiple bots exist for the same meeting (e.g. recording + voice_agent),
 * participants are merged from ALL bots so no speakers are lost.
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

    // Group by meeting_url, keeping preferred bot for display
    // but tracking ALL bot_ids per meeting for complete enrichment
    const grouped = new Map<string, Row>();
    const allBotIdsByKey = new Map<string, string[]>();

    for (const row of rows) {
        const key = row.meeting_url ?? row.bot_id;

        if (!allBotIdsByKey.has(key)) {
            allBotIdsByKey.set(key, []);
        }
        allBotIdsByKey.get(key)!.push(row.bot_id);

        const existing = grouped.get(key);
        if (!existing || row.bot_type === "voice_agent") {
            grouped.set(key, row);
        }
    }
    const meetings = [...grouped.values()];

    // Enrich ALL bot_ids (not just the grouped representative)
    const everyBotId = rows.map((r) => r.bot_id);
    const metaMap = await buildBotMetadataMap(everyBotId);

    return {
        meetings: meetings.map((m) => {
            const key = m.meeting_url ?? m.bot_id;
            const relatedBotIds = allBotIdsByKey.get(key) ?? [m.bot_id];

            // Merge participants and titles from all related bots
            const allParticipants = new Set<string>();
            let title: string | null = null;

            for (const bid of relatedBotIds) {
                const enrichment = metaMap.get(bid);
                if (enrichment) {
                    enrichment.participants.forEach((p) => allParticipants.add(p));
                    if (enrichment.title && !title) title = enrichment.title;
                }
            }

            return {
                ...m,
                title,
                participants: [...allParticipants],
            };
        }),
    };
}

/**
 * GET /api/notes/:botId
 * Returns the transcript for a bot, enriched with meeting title and participants.
 * When multiple bots exist for the same meeting (same meeting_url),
 * utterances from ALL bots are merged into a single chronological transcript.
 */
export async function handleNoteDetail(botId: string): Promise<{
    utterances: any[];
    done: boolean;
    title: string | null;
    participants: string[];
}> {
    // Look up this bot's meeting_url to find sibling bots
    const { data: meetingRow } = await supabase
        .from("meetings")
        .select("meeting_url, done")
        .eq("bot_id", botId)
        .maybeSingle();

    let allBotIds = [botId];
    let isDone = meetingRow?.done ?? false;

    if (meetingRow?.meeting_url) {
        const { data: siblings } = await supabase
            .from("meetings")
            .select("bot_id, done")
            .eq("meeting_url", meetingRow.meeting_url);

        if (siblings && siblings.length > 0) {
            allBotIds = [...new Set(siblings.map((s) => s.bot_id))];
            // Meeting is fully done only when ALL bots are done
            isDone = siblings.every((s) => s.done);
        }
    }

    // Fetch utterances from ALL related bots using pagination
    const PAGE_SIZE = 1000;
    let allUtteranceRows: { speaker: string; words: any; timestamp: string }[] =
        [];

    for (const bid of allBotIds) {
        let offset = 0;
        let hasMore = true;
        while (hasMore) {
            const { data, error } = await supabase
                .from("utterances")
                .select("speaker, words, timestamp")
                .eq("bot_id", bid)
                .range(offset, offset + PAGE_SIZE - 1);

            if (error) {
                console.error(
                    `Error fetching utterances for bot ${bid} (offset ${offset}):`,
                    error,
                );
                break;
            }

            const rows = data ?? [];
            allUtteranceRows = allUtteranceRows.concat(rows);
            hasMore = rows.length === PAGE_SIZE;
            offset += PAGE_SIZE;
        }
    }

    // Sort chronologically by speech time
    allUtteranceRows.sort((a, b) => {
        const aTime =
            (a.words as any[])?.[0]?.end_timestamp?.absolute ??
            new Date(a.timestamp).getTime() / 1000;
        const bTime =
            (b.words as any[])?.[0]?.end_timestamp?.absolute ??
            new Date(b.timestamp).getTime() / 1000;
        return aTime - bTime;
    });

    const utterances = allUtteranceRows.map((row) => ({
        participant: row.speaker,
        words: row.words,
        timestamp: row.timestamp,
    }));

    // Enrich with metadata from all bots
    const metaMap = await buildBotMetadataMap(allBotIds);
    const allParticipants = new Set<string>();
    let title: string | null = null;

    for (const bid of allBotIds) {
        const enrichment = metaMap.get(bid);
        if (enrichment) {
            enrichment.participants.forEach((p) => allParticipants.add(p));
            if (enrichment.title && !title) title = enrichment.title;
        }
    }

    return {
        utterances,
        done: isDone,
        title,
        participants: [...allParticipants],
    };
}
