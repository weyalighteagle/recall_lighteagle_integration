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

    // ── 1. Get unique speakers per bot_id from utterances table ──────────
    // Paginate to avoid Supabase's default 1000-row limit
    const PAGE_SIZE = 1000;
    let utteranceRows: { bot_id: string; speaker: string }[] = [];
    let offset = 0;
    let hasMore = true;

    while (hasMore) {
        const { data } = await supabase
            .from("utterances")
            .select("bot_id, speaker")
            .in("bot_id", botIds)
            .range(offset, offset + PAGE_SIZE - 1);

        const rows = data ?? [];
        utteranceRows = utteranceRows.concat(rows);

        if (rows.length < PAGE_SIZE) {
            hasMore = false;
        } else {
            offset += PAGE_SIZE;
        }
    }

    if (utteranceRows.length > 0) {
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

    // ── 2. Get meeting titles from calendar events via Recall API ────────
    try {
        // Fetch all calendars, then all events from each calendar
        const { calendars } = await calendars_list({});

        for (const calendar of calendars) {
            // Fetch events from the last 90 days to cover recent meetings
            const ninetyDaysAgo = new Date();
            ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);

            let nextPage: string | null = null;
            let allEvents: any[] = [];

            // Paginate through calendar events
            do {
                const result = await calendar_events_list({
                    calendar_id: calendar.id,
                    next: nextPage,
                    start_time__gte: ninetyDaysAgo.toISOString(),
                    start_time__lte: null,
                });
                allEvents = allEvents.concat(result.calendar_events);
                nextPage = result.next;
            } while (nextPage);

            // Cross-reference: find events that have bots matching our bot_ids
            for (const event of allEvents) {
                for (const bot of event.bots ?? []) {
                    const entry = meta.get(bot.bot_id);
                    if (entry) {
                        // Extract title from raw calendar data
                        // Google Calendar uses "summary", Outlook uses "subject"
                        const title = event.raw?.summary ?? event.raw?.subject ?? null;
                        if (title) {
                            entry.title = title;
                        }
                    }
                }
            }
        }
    } catch (err) {
        // If calendar API fails, we still return meetings — just without titles
        console.error("Failed to fetch calendar events for notes enrichment:", err);
    }

    return meta;
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
