import { supabase } from "../config/supabase";
import { calendars_list } from "./calendars_list";
import { calendar_events_list } from "./calendar_events_list";
import { handleGetTranscript } from "./transcript_webhook";

/**
 * Build a map of bot_id → { title, participants } by cross-referencing
 * calendar events (from Recall API) with utterance speakers (from Supabase).
 *
 * Used by recall_webhook.ts for KB auto-ingest title lookup (no user scope needed there).
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
 * Get meeting titles from ALL calendar events (unscoped).
 * Used only by buildBotMetadataMap (KB auto-ingest path) — not user-scoped by design.
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
 * Fetch bot IDs and their calendar event titles for a specific user's calendars only.
 * Used by handleNotesList to (a) scope the DB query to this user's meetings and
 * (b) provide meeting titles without a second round-trip.
 */
async function fetchCalendarBotMeta(
    userEmail: string,
): Promise<Map<string, { title: string | null }>> {
    const meta = new Map<string, { title: string | null }>();
    try {
        const { calendars: allCalendars } = await calendars_list({ platform_email: userEmail });
        const calendars = allCalendars.filter((c) => c.platform_email === userEmail);
        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

        await Promise.all(
            calendars.map(async (calendar) => {
                try {
                    const result = await calendar_events_list({
                        calendar_id: calendar.id,
                        next: null,
                        start_time__gte: thirtyDaysAgo.toISOString(),
                        start_time__lte: null,
                    });
                    for (const event of result.calendar_events) {
                        const title = event.raw?.summary ?? event.raw?.subject ?? null;
                        for (const bot of event.bots ?? []) {
                            meta.set(bot.bot_id, { title });
                        }
                    }
                } catch {
                    /* calendar API failure is non-fatal */
                }
            }),
        );
    } catch {
        /* calendar API failure is non-fatal */
    }
    return meta;
}

type MeetingRow = {
    bot_id: string;
    bot_type: string | null;
    meeting_url: string | null;
    done: boolean;
    created_at: string;
meeting_title: string | null;
    meeting_start_time: string | null;
    attendee_emails?: string[];
};

/**
 * GET /api/notes
 * Returns meetings scoped to the authenticated user:
 *   1. Meetings whose bot_id appears in the user's Recall.ai calendar events (last 30 days).
 *   2. Meetings where user_email = userEmail in the DB (ad-hoc bots, newer calendar bots).
 * Results are enriched with calendar titles and participant names.
 */
export async function handleNotesList(userEmail: string): Promise<{
    meetings: {
        bot_id: string;
        bot_type: string | null;
        meeting_url: string | null;
        done: boolean;
        created_at: string;
        meeting_start_time: string | null;
        title: string | null;
        participants: string[];
    }[];
}> {
    // Fetch user's calendar bot IDs + titles first (needed to build the DB filter)
    const calendarMeta = await fetchCalendarBotMeta(userEmail);
    const calendarBotIds = [...calendarMeta.keys()];

    // Three-pronged DB query: calendar-scoped bots + user_email-scoped bots + guest-attended bots.
    // Separate queries to avoid complex PostgREST filter syntax.
    const nowIso = new Date().toISOString();
    const [calendarResult, userResult, guestResult] = await Promise.all([
        calendarBotIds.length > 0
            ? supabase
                  .from("meetings")
                  .select("bot_id, bot_type, meeting_url, done, created_at, meeting_title, meeting_start_time")
                  .in("bot_id", calendarBotIds)
                  .is("user_email", null)   // calendar path is for legacy/scheduled bots only;
                                            // instant meeting bots (user_email set) are handled
                                            // exclusively by the userResult query below
                  .or(`done.eq.true,meeting_start_time.lte.${nowIso}`)
                  .order("meeting_start_time", { ascending: false, nullsFirst: false })
            : Promise.resolve({ data: [] as MeetingRow[], error: null }),
        supabase
            .from("meetings")
            .select("bot_id, bot_type, meeting_url, done, created_at, meeting_title, meeting_start_time")
            .eq("user_email", userEmail)
            .or(`done.eq.true,meeting_start_time.lte.${nowIso}`)
            .order("meeting_start_time", { ascending: false, nullsFirst: false }),
        // Guest path: meetings the user attended but didn't schedule
        supabase
            .from("meetings")
            .select("bot_id, bot_type, meeting_url, done, created_at, meeting_start_time")
            .contains("attendee_emails", [userEmail])
            .neq("user_email", userEmail)
            .or(`done.eq.true,meeting_start_time.lte.${nowIso}`)
            .order("meeting_start_time", { ascending: false, nullsFirst: false }),
    ]);

    // Merge and deduplicate by bot_id, keeping newest ordering
    const rowMap = new Map<string, MeetingRow>();
    for (const row of [
        ...((calendarResult.data as MeetingRow[] | null) ?? []),
        ...((userResult.data as MeetingRow[] | null) ?? []),
        ...((guestResult.data as MeetingRow[] | null) ?? []),
    ]) {
        rowMap.set(row.bot_id, row);
    }
    const allRows = [...rowMap.values()].sort(
        (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
    );

    // Hoist utterance fetch before grouping so we can prefer the bot_id that
    // actually received utterances when multiple bots share a meeting_url.
    const allCandidateIds = allRows.map((r) => r.bot_id);
    const botsWithUtterances = new Set<string>();
    if (allCandidateIds.length > 0) {
        const { data: uRows } = await supabase
            .from("utterances")
            .select("bot_id")
            .in("bot_id", allCandidateIds)
            .limit(5000);
        for (const r of uRows ?? []) botsWithUtterances.add(r.bot_id);
    }

    // Group by meeting_url — prefer voice_agent bot when both a recording and
    // voice_agent bot attended the same meeting URL.
    const grouped = new Map<string, MeetingRow>();
    for (const row of allRows) {
        const key = row.meeting_url ?? row.bot_id;
        const existing = grouped.get(key);
        if (!existing) {
            grouped.set(key, row);
            continue;
        }
        const rowHasUtterances = botsWithUtterances.has(row.bot_id);
        const existingHasUtterances = botsWithUtterances.has(existing.bot_id);
        // Prefer the bot with utterances; break ties by preferring voice_agent.
        if (rowHasUtterances && !existingHasUtterances) {
            grouped.set(key, row);
        } else if (rowHasUtterances === existingHasUtterances && row.bot_type === "voice_agent") {
            grouped.set(key, row);
        }
    }
    const groupedMeetings = [...grouped.values()];

    // Hide recording-bot rows that have a voice_agent sibling in this user's scoped
    // result set: same owner, created within 30 s, and the voice_agent has utterances.
    // This suppresses the ghost "Processing" duplicate without deleting any data.
    // The filter operates entirely on the already-ownership-scoped rowset — it never
    // crosses user boundaries.
    const vaWithUtterancesTimes = groupedMeetings
        .filter((m) => m.bot_type === "voice_agent" && botsWithUtterances.has(m.bot_id))
        .map((m) => new Date(m.created_at).getTime());

    const meetings = groupedMeetings.filter((m) => {
        if (m.bot_type !== "recording" || m.done || botsWithUtterances.has(m.bot_id)) {
            return true;
        }
        const rowTime = new Date(m.created_at).getTime();
        return !vaWithUtterancesTimes.some((vaTime) => Math.abs(vaTime - rowTime) <= 30_000);
    });

    const filteredCount = groupedMeetings.length - meetings.length;
    if (filteredCount > 0) {
        console.log(
            `[handleNotesList] suppressed ${filteredCount} ghost recording-bot row(s) for ${userEmail} (voice_agent sibling present within 30s)`,
        );
    }

    // Enrich with titles and participants — scoped to the post-grouping bot_ids only.
    const botIds = meetings.map((m) => m.bot_id);
    const participantsMap = new Map<string, string[]>();
    for (const id of botIds) participantsMap.set(id, []);

    if (botIds.length > 0) {
        const { data: utteranceRows } = await supabase
            .from("utterances")
            .select("bot_id, speaker")
            .in("bot_id", botIds)
            .limit(1000);

        for (const row of utteranceRows ?? []) {
            const speakers = participantsMap.get(row.bot_id);
            if (speakers && !speakers.includes(row.speaker)) {
                speakers.push(row.speaker);
            }
        }
    }

    return {
        meetings: meetings.map((m) => ({
            ...m,

            // Resolution order: user-set DB title > calendar-API-derived title > null
            title: m.meeting_title ?? calendarMeta.get(m.bot_id)?.title ?? null,
            meeting_start_time: m.meeting_start_time ?? m.created_at,

            participants: participantsMap.get(m.bot_id) ?? [],
        })),
    };
}

/**
 * Verify that the authenticated user is allowed to access a meeting's transcript.
 * Authorization passes when ANY of the following is true:
 *   a) meetings.user_email = userEmail (set at bot creation time — fast DB path)
 *   b) user_email is NULL (legacy row) AND bot_id appears in the user's calendar events
 * Throws with statusCode 403 if authorization fails, 404 if meeting doesn't exist.
 */
async function assertMeetingOwnership(botId: string, userEmail: string): Promise<void> {
    const { data: meeting } = await supabase
        .from("meetings")
        .select("user_email, attendee_emails")
        .eq("bot_id", botId)
        .maybeSingle();

    if (!meeting) {
        throw Object.assign(new Error("Meeting not found"), { statusCode: 404 });
    }

    // Fast path: explicit user_email match
    if (meeting.user_email === userEmail) return;

    // Guest path: user attended the meeting but didn't schedule the bot
    const attendees: string[] = Array.isArray(meeting.attendee_emails) ? meeting.attendee_emails : [];
    if (attendees.includes(userEmail)) return;

    // Another user's meeting — user_email is set but doesn't match
    if (meeting.user_email !== null) {
        throw Object.assign(new Error("Forbidden"), { statusCode: 403 });
    }

    // Legacy meeting (user_email = NULL): fall back to calendar cross-reference.
    // Recall.ai /calendars endpoint ignores platform_email filter and returns all
    // workspace calendars — never use it as the sole ownership check.
    // This fallback is intentionally kept only for legacy calendar-scheduled bots
    // (user_email = NULL rows created before user scoping was added). Instant meeting
    // bots created via /api/bot/join always have user_email set (enforced in index.ts),
    // so they never reach this branch.
    const calendarMeta = await fetchCalendarBotMeta(userEmail);
    if (!calendarMeta.has(botId)) {
        throw Object.assign(new Error("Forbidden"), { statusCode: 403 });
    }
}

/**
 * GET /api/notes/:botId
 * Returns the transcript for a bot, enriched with meeting title and participants.
 * Verifies the authenticated user owns the meeting before returning data.
 */
export async function handleNoteDetail(
    botId: string,
    userEmail: string,
): Promise<{
    utterances: any[];
    done: boolean;
    bot_type: string | null;
    title: string | null;
    participants: string[];
}> {
    // Verify ownership before touching transcript data
    await assertMeetingOwnership(botId, userEmail);

    const [transcript, meetingMeta, metaMap] = await Promise.all([
        handleGetTranscript(botId),
        supabase.from("meetings").select("bot_type, meeting_title").eq("bot_id", botId).maybeSingle(),
        buildBotMetadataMap([botId]),
    ]);

    const enrichment = metaMap.get(botId);

    return {
        ...transcript,
        bot_type: meetingMeta.data?.bot_type ?? null,
        // Resolution order: user-set DB title > calendar-API-derived title > null
        // (identical ordering to handleNotesList — must stay in sync)
        title: meetingMeta.data?.meeting_title ?? enrichment?.title ?? null,
        participants: enrichment?.participants ?? [],
    };
}

/**
 * PATCH /api/notes/:botId
 * Updates the user-editable meeting_title column for a meeting the caller owns.
 * Returns the saved title so the client can reconcile its optimistic update.
 */
export async function handleMeetingTitleUpdate(
    botId: string,
    userEmail: string,
    rawTitle: unknown,
): Promise<{ title: string }> {
    if (typeof rawTitle !== "string") {
        throw Object.assign(new Error("title must be a string"), { statusCode: 400 });
    }
    const title = rawTitle.trim();
    if (!title) {
        throw Object.assign(new Error("Title cannot be empty"), { statusCode: 400 });
    }
    if (title.length > 200) {
        throw Object.assign(new Error("Title cannot exceed 200 characters"), { statusCode: 400 });
    }

    await assertMeetingOwnership(botId, userEmail);

    // TODO: KB chunks currently embed the old meeting title as a prefix for semantic
    // retrieval of proper nouns. Renaming a meeting does not re-embed its chunks.
    // Decision pending on whether rename should trigger re-embedding of associated
    // kb_chunks rows. See Notion task: [Category-scoped KB] for broader context.
    const { error } = await supabase
        .from("meetings")
        .update({ meeting_title: title })
        .eq("bot_id", botId);

    if (error) {
        throw Object.assign(new Error("Failed to update meeting title"), { statusCode: 500 });
    }

    return { title };
}
