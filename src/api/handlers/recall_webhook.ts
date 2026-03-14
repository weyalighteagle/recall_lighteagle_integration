import { z } from "zod";
import { CalendarSchema, type CalendarType } from "../../schemas/CalendarArtifactSchema";
import { CalendarEventSchema, type CalendarEventType } from "../../schemas/CalendarEventArtifactSchema";
import { CalendarSyncEventsEventSchema } from "../../schemas/CalendarSyncEventsEventSchema";
import { CalendarUpdateEventSchema } from "../../schemas/CalendarUpdateEventSchema";
import { env } from "../config/env";
import { fetch_with_retry } from "../fetch_with_retry";
import { supabase } from "../config/supabase";
import { handleTranscriptWebhook } from "./transcript_webhook";

export async function recall_webhook(payload: any): Promise<void> {
    // Route transcript events to the transcript webhook handler
    if (payload?.event === "transcript.data" || payload?.event === "transcript.done") {
        await handleTranscriptWebhook(payload);
        return;
    }

    // Route bot.done events to the full-transcript handler
    if (payload?.event === "bot.done") {
        await handleBotDone(payload);
        return;
    }

    const result = z.discriminatedUnion("event", [
        CalendarUpdateEventSchema,
        CalendarSyncEventsEventSchema,
    ]).safeParse(payload);
    if (!result.success) {
        console.log(`Received unhandled Recall webhook event: ${JSON.stringify(payload)}`);
        return;
    }
    const { event, data } = result.data;

    const calendar = await calendar_retrieve({ calendar_id: data.calendar_id });
    console.log(`Found calendar: ${JSON.stringify(calendar)}`);

    switch (event) {
        case "calendar.update": {
            console.log(`Calendar update event received: ${JSON.stringify(data)}`);
            break;
        }
        case "calendar.sync_events": {
            let next: string | null = null;
            do {

                const { results, next: new_next } = await calendar_events_list({
                    updated_at__gte: data.last_updated_ts,
                    calendar_id: data.calendar_id,
                    next,
                });
                console.log(`Received ${results.length} calendar events.`);

                for (const calendar_event of results) {
                    // Recall automatically unschedules bot if the calendar event is deleted.
                    if (calendar_event.is_deleted) continue;
                    // Skip calendar events that don't have a meeting URL or start time.
                    if (!calendar_event.meeting_url || !calendar_event.start_time) continue;
                    // Skip calendar events that have already passed.
                    if (new Date(calendar_event.start_time) <= new Date()) continue;

                    // Schedule a bot for the calendar event if it doesn't already have one.
                    await schedule_bot_for_calendar_event({ calendar_event, calendar });
                    console.log(`Scheduled bot for calendar event: ${calendar_event.id}`);
                }
                next = new_next;
            } while (next);

            console.log(`Calendar sync events event received: ${JSON.stringify(data)}`);
            break;
        }
    }

    return;
}

/**
 * Handle bot.done webhook: fetch the complete post-meeting transcript from Recall,
 * replace all real-time utterances in Supabase, and mark the meeting as done.
 * Always resolves without throwing so the caller always returns 200 to Recall.
 */
async function handleBotDone(body: any): Promise<void> {
    const botId: string | undefined = body?.data?.bot?.id;

    if (!botId) {
        console.error("bot.done received without bot_id:", JSON.stringify(body));
        return;
    }

    console.log(`bot.done received for bot ${botId} — fetching full transcript`);

    // Step 1: Fetch bot details from Recall v1 API to get the transcript download URL
    let downloadUrl: string | null = null;
    try {
        const botResponse = await fetch_with_retry(
            `https://${env.RECALL_REGION}.recall.ai/api/v1/bot/${botId}/`,
            {
                method: "GET",
                headers: {
                    "Authorization": `${env.RECALL_API_KEY}`,
                    "Content-Type": "application/json",
                },
            },
        );

        if (!botResponse.ok) {
            console.error(`Failed to fetch bot details for ${botId}:`, await botResponse.text());
        } else {
            const botData = await botResponse.json();
            downloadUrl =
                botData?.recordings?.[0]?.media_shortcuts?.transcript?.data?.download_url ?? null;

            if (downloadUrl) {
                console.log(`Got transcript download URL for bot ${botId}`);
            } else {
                console.log(`No transcript download URL for bot ${botId}. media_shortcuts:`,
                    JSON.stringify(botData?.recordings?.[0]?.media_shortcuts ?? null));
            }
        }
    } catch (err) {
        console.error(`Unexpected error fetching bot details for ${botId}:`, err);
    }

    // Step 2: Download the full transcript JSON
    // Expected shape: [{ "speaker": "Name", "words": [{text, start_timestamp, end_timestamp}] }]
    type TranscriptSegment = { speaker?: string; participant?: { name?: string }; words: unknown[] };
    let segments: TranscriptSegment[] = [];

    if (downloadUrl) {
        try {
            const transcriptResponse = await fetch(downloadUrl);
            if (!transcriptResponse.ok) {
                console.error(`Failed to download transcript for bot ${botId}:`,
                    await transcriptResponse.text());
            } else {
                const rawJson: unknown = await transcriptResponse.json();

                // Guard: transcript download must be a top-level array
                if (!Array.isArray(rawJson)) {
                    console.error(`Transcript for bot ${botId} is not an array — actual shape:`,
                        JSON.stringify(rawJson));
                } else {
                    segments = rawJson as TranscriptSegment[];
                    // Log the first segment so Railway shows the exact field names coming from Recall
                    console.log(`Downloaded transcript for bot ${botId}: ${segments.length} segments. First segment:`,
                        JSON.stringify(segments[0] ?? null));
                }
            }
        } catch (err) {
            console.error(`Unexpected error downloading transcript for bot ${botId}:`, err);
        }
    }

    // Step 3: Replace real-time utterances with the complete transcript
    if (segments.length > 0) {
        // 3a: Delete existing utterances
        try {
            const { error: deleteError } = await supabase
                .from("utterances")
                .delete()
                .eq("bot_id", botId);

            if (deleteError) {
                console.error(`Failed to delete existing utterances for bot ${botId}:`,
                    { bot_id: botId, error: deleteError });
            } else {
                console.log(`Deleted existing utterances for bot ${botId}`);
            }
        } catch (err) {
            console.error(`Unexpected error deleting utterances for bot ${botId}:`, err);
        }

        // 3b: Insert final utterances
        try {
            const rows = segments.map((seg) => {
                const speaker = seg.participant?.name ?? seg.speaker ?? "Unknown";
                if (speaker === "Unknown") {
                    console.warn(`Segment missing speaker for bot ${botId} — raw segment:`,
                        JSON.stringify(seg));
                }
                return {
                    bot_id: botId,
                    speaker,
                    words: seg.words,
                };
            });

            const { error: insertError } = await supabase
                .from("utterances")
                .insert(rows);

            if (insertError) {
                console.error(`Failed to insert final utterances for bot ${botId}:`,
                    { bot_id: botId, error: insertError, segmentCount: rows.length });
            } else {
                console.log(`Inserted ${rows.length} final utterances for bot ${botId}`);
            }
        } catch (err) {
            console.error(`Unexpected error inserting final utterances for bot ${botId}:`, err);
        }
    }

    // Step 4: Mark the meeting as done (runs regardless of transcript availability)
    try {
        const { error: doneError } = await supabase
            .from("meetings")
            .update({ done: true })
            .eq("bot_id", botId);

        if (doneError) {
            console.error(`Failed to mark meeting done for bot ${botId}:`,
                { bot_id: botId, error: doneError });
        } else {
            console.log(`Marked meeting done for bot ${botId}`);
        }
    } catch (err) {
        console.error(`Unexpected error marking meeting done for bot ${botId}:`, err);
    }
}

/**
 * Retrieve a calendar from Recall.
 */
export async function calendar_retrieve(args: { calendar_id: string, }) {
    const { calendar_id } = z.object({
        calendar_id: z.string(),
    }).parse(args);

    const response = await fetch_with_retry(`https://${env.RECALL_REGION}.recall.ai/api/v2/calendars/${calendar_id}`, {
        method: "GET",
        headers: {
            "Authorization": `${env.RECALL_API_KEY}`,
            "Content-Type": "application/json",
        },
    });
    if (!response.ok) throw new Error(await response.text());

    return CalendarSchema.parse(await response.json());
}

/**
 * List calendar events for a given calendar from Recall.
 */
export async function calendar_events_list(args: { updated_at__gte?: string | null, calendar_id: string, next: string | null }) {
    const { updated_at__gte, calendar_id, next } = z.object({
        updated_at__gte: z.string().nullish(),
        calendar_id: z.string(),
        next: z.string().nullable(),
    }).parse(args);

    const url = new URL(`https://${env.RECALL_REGION}.recall.ai/api/v2/calendar-events/`);
    url.searchParams.set("calendar_id", calendar_id);
    if (next) url.searchParams.set("next", next);
    if (updated_at__gte) url.searchParams.set("updated_at__gte", updated_at__gte);

    const response = await fetch_with_retry(url.toString(), {
        method: "GET",
        headers: {
            "Authorization": `${env.RECALL_API_KEY}`,
            "Content-Type": "application/json",
        },
    });
    if (!response.ok) throw new Error(await response.text());

    return z.object({
        next: z.string().nullable(),
        results: CalendarEventSchema.array(),
    }).parse(await response.json());
}

/**
 * Retrieve a calendar event from Recall.
 */
export async function calendar_event_retrieve(args: {
    calendar_event_id: string,
}) {
    const { calendar_event_id } = z.object({
        calendar_event_id: z.string(),
    }).parse(args);

    const response = await fetch_with_retry(`https://${env.RECALL_REGION}.recall.ai/api/v2/calendar-events/${calendar_event_id}`, {
        method: "GET",
        headers: {
            "Authorization": `${env.RECALL_API_KEY}`,
            "Content-Type": "application/json",
        },
    });
    if (!response.ok) throw new Error(await response.json());

    return CalendarEventSchema.parse(await response.json());
}

/**
 * Unschedule a bot for a given calendar event.
 */
export async function unschedule_bot_for_calendar_event(args: {
    calendar_event_id: string,
}) {
    const { calendar_event_id } = z.object({
        calendar_event_id: z.string(),
    }).parse(args);

    const response = await fetch_with_retry(`https://${env.RECALL_REGION}.recall.ai/api/v2/calendar-events/${calendar_event_id}/bot`, {
        method: "DELETE",
        headers: {
            "Authorization": `${env.RECALL_API_KEY}`,
            "Content-Type": "application/json",
        },
    });
    if (!response.ok) throw new Error(await response.text());
    return CalendarEventSchema.parse(await response.json());
}

/**
 * Schedule a bot for a given calendar event.
 * It will show up in the bot list as `${calendar.platform_email}'s notetaker'`.
 */
export async function schedule_bot_for_calendar_event(args: {
    calendar: CalendarType,
    calendar_event: CalendarEventType,
}) {
    const { calendar, calendar_event } = z.object({
        calendar: CalendarSchema,
        calendar_event: CalendarEventSchema,
    }).parse(args);

    const { deduplication_key } = generate_bot_deduplication_key({
        one_bot_per: "meeting",
        email: calendar.platform_email!,
        meeting_url: calendar_event.meeting_url!,
        meeting_start_timestamp: calendar_event.start_time,
    });

    const response = await fetch_with_retry(`https://${env.RECALL_REGION}.recall.ai/api/v2/calendar-events/${calendar_event.id}/bot`, {
        method: "POST",
        headers: {
            "Authorization": `${env.RECALL_API_KEY}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            deduplication_key,
            bot_config: {
                bot_name: `WEYA by Light Eagle`,
                // meeting_url and start_time is automatically updated by Recall when we call the schedule bot for calendar event endpoint.
                recording_config: {
                    transcript: {
                        provider: { recallai_streaming: {} },
                    },
                    realtime_endpoints: [
                        {
                            type: "webhook",
                            url: `https://${env.RAILWAY_DOMAIN}/api/webhooks/transcript`,
                            events: ["transcript.data", "transcript.partial_data"],
                        },
                    ],
                },
            },
        }),
    });
    if (!response.ok) throw new Error(await response.text());

    return CalendarEventSchema.parse(await response.json());
}

/**
 * Generate a deduplication key for a bot based on the one_bot_per, email, meeting_url, and meeting_start_timestamp.
 */
function generate_bot_deduplication_key(args: {
    one_bot_per: "user" | "email_domain" | "meeting",
    email: string,
    meeting_url: string,
    meeting_start_timestamp: string,
}) {
    const { one_bot_per, email, meeting_url, meeting_start_timestamp } = z.object({
        one_bot_per: z.enum(["user", "email_domain", "meeting"]),
        email: z.string(),
        meeting_url: z.string(),
        meeting_start_timestamp: z.string(),
    }).parse(args);

    switch (one_bot_per) {
        case "user": {
            // Deduplicate at user level: every user who has a bot scheduled will get their own bot.
            return { deduplication_key: `${email}-${meeting_url}-${meeting_start_timestamp}` };
        }
        case "email_domain": {
            // Deduplicate at company/domain level: one shared bot for everyone from that domain on this meeting occurrence.
            return { deduplication_key: `${email.split("@")[1]}-${meeting_url}-${meeting_start_timestamp}` };
        }
        case "meeting": {
            // Deduplicate at meeting level: one bot for the entire meeting regardless of who scheduled it.
            return { deduplication_key: `${meeting_url}-${meeting_start_timestamp}` };
        }
    }
}
