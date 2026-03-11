import { z } from "zod";
import { CalendarSchema, type CalendarType } from "../../schemas/CalendarArtifactSchema";
import { CalendarEventSchema, type CalendarEventType } from "../../schemas/CalendarEventArtifactSchema";
import { CalendarSyncEventsEventSchema } from "../../schemas/CalendarSyncEventsEventSchema";
import { CalendarUpdateEventSchema } from "../../schemas/CalendarUpdateEventSchema";
import { env } from "../config/env";
import { fetch_with_retry } from "../fetch_with_retry";

// ─── Yeni: recording.done ve transcript.done schema'ları ───────────────────────

const RecordingDoneEventSchema = z.object({
    event: z.literal("recording.done"),
    data: z.object({
        recording: z.object({ id: z.string() }),
        bot: z.object({ id: z.string() }).nullable().optional(),
    }),
});

const TranscriptDoneEventSchema = z.object({
    event: z.literal("transcript.done"),
    data: z.object({
        transcript: z.object({ id: z.string() }),
        recording: z.object({ id: z.string() }),
        bot: z.object({ id: z.string() }).nullable().optional(),
    }),
});

// ─── In-memory store (DB yokken geçici saklama) ────────────────────────────────
// bot_id → { recording_id, transcript_download_url, transcript_text }
const meetingStore = new Map<string, {
    recording_id?: string;
    transcript_download_url?: string;
    transcript_text?: string;
}>();

export function get_meeting_data(bot_id: string) {
    return meetingStore.get(bot_id) ?? null;
}

export function list_meeting_data() {
    return Array.from(meetingStore.entries()).map(([bot_id, data]) => ({ bot_id, ...data }));
}

// ──────────────────────────────────────────────────────────────────────────────

export async function recall_webhook(payload: any): Promise<void> {

    // Yeni: recording.done handler
    const recordingResult = RecordingDoneEventSchema.safeParse(payload);
    if (recordingResult.success) {
        const { data } = recordingResult.data;
        const recording_id = data.recording.id;
        const bot_id = data.bot?.id;

        console.log(`recording.done received — recording_id: ${recording_id}, bot_id: ${bot_id}`);

        // bot_id varsa store'a kaydet
        if (bot_id) {
            meetingStore.set(bot_id, { ...meetingStore.get(bot_id), recording_id });
        }

        // Async transcript job başlat
        await create_async_transcript({ recording_id });
        console.log(`Async transcript job started for recording: ${recording_id}`);
        return;
    }

    // Yeni: transcript.done handler
    const transcriptResult = TranscriptDoneEventSchema.safeParse(payload);
    if (transcriptResult.success) {
        const { data } = transcriptResult.data;
        const transcript_id = data.transcript.id;
        const bot_id = data.bot?.id;

        console.log(`transcript.done received — transcript_id: ${transcript_id}, bot_id: ${bot_id}`);

        // Transcript verisini çek
        const transcript = await retrieve_transcript({ transcript_id });
        const download_url = transcript?.data?.download_url;

        if (!download_url) {
            console.log(`No download_url found for transcript: ${transcript_id}`);
            return;
        }

        // Transkript JSON'unu indir
        const transcript_text = await download_transcript({ download_url });

        // Store'a kaydet
        if (bot_id) {
            meetingStore.set(bot_id, {
                ...meetingStore.get(bot_id),
                transcript_download_url: download_url,
                transcript_text,
            });
        }

        console.log(`Transcript saved for bot: ${bot_id}`);
        console.log(`Transcript preview: ${transcript_text?.slice(0, 200)}...`);
        return;
    }

    // Mevcut calendar event handler'ları (değişmedi)
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

// ─── Yeni: Async transcript job başlat ────────────────────────────────────────

async function create_async_transcript(args: { recording_id: string }) {
    const { recording_id } = args;

    const response = await fetch_with_retry(
        `https://${env.RECALL_REGION}.recall.ai/api/v1/recording/${recording_id}/create_transcript/`,
        {
            method: "POST",
            headers: {
                "Authorization": `${env.RECALL_API_KEY}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                provider: {
                    recallai_async: {
                        language_code: "tr",
                    },
                },
            }),
        }
    );

    if (!response.ok) {
        const err = await response.text();
        console.error(`Failed to create async transcript: ${err}`);
        return null;
    }

    return await response.json();
}

// ─── Yeni: Transcript verisini Recall'dan çek ─────────────────────────────────

async function retrieve_transcript(args: { transcript_id: string }) {
    const { transcript_id } = args;

    const response = await fetch_with_retry(
        `https://${env.RECALL_REGION}.recall.ai/api/v1/transcript/${transcript_id}/`,
        {
            method: "GET",
            headers: {
                "Authorization": `${env.RECALL_API_KEY}`,
                "Content-Type": "application/json",
            },
        }
    );

    if (!response.ok) {
        console.error(`Failed to retrieve transcript: ${await response.text()}`);
        return null;
    }

    return await response.json();
}

// ─── Yeni: download_url'den transkript JSON'unu indir ─────────────────────────

async function download_transcript(args: { download_url: string }): Promise<string | null> {
    const { download_url } = args;

    try {
        const response = await fetch(download_url);
        if (!response.ok) {
            console.error(`Failed to download transcript from URL`);
            return null;
        }
        const json = await response.json();
        // Okunabilir formata çevir: "Speaker: text\n" şeklinde
        if (Array.isArray(json)) {
            return json
                .map((part: any) => `${part.speaker ?? "Unknown"}: ${part.words?.map((w: any) => w.text).join(" ") ?? ""}`)
                .join("\n");
        }
        return JSON.stringify(json);
    } catch (err) {
        console.error(`Error downloading transcript: ${err}`);
        return null;
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
                bot_name: "WEYA by Light Eagle",
                recording_config: {
                    video_mixed_mp4: {},
                    transcript: {
                        provider: { recallai_async: { language_code: "tr" } },
                    },
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
            return { deduplication_key: `${email}-${meeting_url}-${meeting_start_timestamp}` };
        }
        case "email_domain": {
            return { deduplication_key: `${email.split("@")[1]}-${meeting_url}-${meeting_start_timestamp}` };
        }
        case "meeting": {
            return { deduplication_key: `${meeting_url}-${meeting_start_timestamp}` };
        }
    }
}