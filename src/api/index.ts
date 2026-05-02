import http from "http";
import dotenv from "dotenv";
import { env } from "./config/env";
import { calendar_events_list } from "./handlers/calendar_events_list";
import { calendar_oauth } from "./handlers/calendar_oauth";
import { calendar_oauth_callback } from "./handlers/calendar_oauth_callback";
import { calendars_delete } from "./handlers/calendars_delete";
import { calendars_list } from "./handlers/calendars_list";
import { calendar_event_retrieve, calendar_retrieve, recall_webhook, schedule_bot_for_calendar_event, unschedule_bot_for_calendar_event, kb_retry_ingestion } from "./handlers/recall_webhook";

import { kb_list, kb_create, kb_delete, kb_toggle, kb_get, kb_update, tag_list, tag_create, tag_update, tag_delete, doc_tag_add, doc_tag_remove, meeting_tags_get, meeting_tags_set, meeting_allowed_tags } from "./handlers/knowledge_base";

import { handleTranscriptWebhook, handleGetTranscript } from "./handlers/transcript_webhook";
import { handleNotesList, handleNoteDetail, handleMeetingTitleUpdate } from "./handlers/notes";
import { handleVoiceAgentStatus } from "./handlers/voice_agent_status";
import { bot_join } from "./handlers/bot_join";
import { bot_settings_get, bot_settings_update } from "./handlers/bot_settings";
import { voice_agent_config_get, voice_agent_config_update } from "./handlers/voice_agent_config";
import { voice_agent_photo_upload, voice_agent_photo_delete } from "./handlers/voice_agent_photo";
import { knowledge_bases_list, knowledge_base_by_slug } from "./handlers/knowledge_bases";
import { meeting_kb_get, meeting_kb_upsert, meeting_kb_delete } from "./handlers/meeting_kb_override";
import { supabase } from "./config/supabase";
import { requireAuth } from "./middleware/auth";

dotenv.config();

const server = http.createServer();
const client_domain = process.env.CLIENT_DOMAIN || "http://localhost:5173";

/**
 * HTTP server for handling HTTP requests from Recall.ai
 */
server.on("request", async (req, res) => {
    try {
        // Parse the request
        const url = new URL(`https://${req.headers.host?.replace("https://", "")}${req.url}`);
        const pathname = url.pathname.at(-1) === "/" ? url.pathname.slice(0, -1) : url.pathname;
        const search_params = Object.fromEntries(url.searchParams.entries()) as any;
        let body: any | null = null;
        try {
            if (["POST", "PUT", "PATCH", "DELETE"].includes(req.method!)) {
                const body_chunks: Buffer[] = [];
                for await (const chunk of req) {
                    body_chunks.push(chunk);
                }
                const raw_body = Buffer.concat(body_chunks).toString("utf-8");
                if (raw_body.trim()) body = JSON.parse(raw_body);
            }
        } catch (error) {
            console.log("Error parsing body", error);
        }

        console.log(`
Incoming HTTP request: ${req.method} ${pathname} 
search_params=${JSON.stringify(search_params)} 
body=${JSON.stringify(body)}
        `);

        // Handle CORS preflight requests
        if (req.method === "OPTIONS") {
            res.writeHead(204, {
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
                "Access-Control-Allow-Headers": "Content-Type, Authorization",
            });
            res.end();
            return;
        }

        switch (pathname) {
            /** OAuth endpoints */
            case "/api/calendar/oauth": {
                if (req.method?.toUpperCase() !== "GET") throw new Error(`Method not allowed: ${req.method}`);

                const calendar_oauth_url = await calendar_oauth(search_params);
                console.log(`Created Calendar OAuth URL: ${calendar_oauth_url.oauth_url.toString()}`);

                // redirect to the Calendar OAuth URL
                res.writeHead(302, { Location: calendar_oauth_url.oauth_url.toString() });
                res.end();
                return;
            }
            case "/api/calendar/oauth/callback": {
                if (req.method?.toUpperCase() !== "GET") throw new Error(`Method not allowed: ${req.method}`);

                const { calendar } = await calendar_oauth_callback(search_params);
                console.log(`Created Calendar: ${JSON.stringify(calendar)}`);

                res.writeHead(302, { Location: `${client_domain}/dashboard/calendar` });
                res.end();
                return;
            }

            /** Webhook endpoints */
            case "/api/recall/webhook": {
                if (req.method?.toUpperCase() !== "POST") throw new Error(`Method not allowed: ${req.method}`);

                console.log(`Recall webhook received: ${JSON.stringify(body)}`);
                await recall_webhook(body);

                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ message: "Recall webhook received" }));
                return;
            }
            case "/api/webhooks/transcript": {
                if (req.method?.toUpperCase() !== "POST") throw new Error(`Method not allowed: ${req.method}`);

                console.log(`Transcript webhook received: ${JSON.stringify(body)}`);
                const transcriptResult = await handleTranscriptWebhook(body);

                res.writeHead(transcriptResult.status, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ message: "Transcript webhook received" }));
                return;
            }

            /** Dashboard endpoints */
            case "/api/calendar": {
                switch (req.method?.toUpperCase()) {
                    /** List calendars */
                    case "GET": {
                        if (!await requireAuth(req, res)) return;
                        const email = (req as any).userEmail;
                        const { calendars: allCalendars } = await calendars_list({ ...search_params, platform_email: email });
                        const results = { calendars: allCalendars.filter((c) => c.platform_email === email) };
                        console.log(`Listed Calendars: ${JSON.stringify(results)}`);

                        res.writeHead(200, { "Content-Type": "application/json" });
                        res.end(JSON.stringify(results));
                        return;
                    }
                    /** Delete calendar */
                    case "DELETE": {
                        if (!await requireAuth(req, res)) return;
                        if (!search_params.calendar_id) throw new Error("calendar_id is required");

                        await calendars_delete(search_params);
                        console.log(`Deleted Calendar: ${url.pathname.split("/").pop()!}`);

                        res.writeHead(200, { "Content-Type": "application/json" });
                        res.end(JSON.stringify({ message: "Calendar deleted" }));
                        return;
                    }
                    default: {
                        throw new Error(`Method not allowed: ${req.method}`);
                    }
                }
            }
            case "/api/calendar/events": {
                switch (req.method?.toUpperCase()) {
                    // List the calendar events for a given calendar.
                    case "GET": {
                        if (!await requireAuth(req, res)) return;
                        if (!search_params.calendar_id) throw new Error("calendar_id is required");

                        const results = await calendar_events_list(search_params);
                        console.log(`Listed Calendar Events: ${results.calendar_events.length}`);

                        res.writeHead(200, { "Content-Type": "application/json" });
                        res.end(JSON.stringify(results));
                        return;
                    }
                    default: {
                        throw new Error(`Method not allowed: ${req.method}`);
                    }
                }
            }
            case "/api/kb": {
                switch (req.method?.toUpperCase()) {
                    case "GET": {
                        const results = await kb_list();
                        res.writeHead(200, { "Content-Type": "application/json" });
                        res.end(JSON.stringify(results));
                        return;
                    }
                    case "POST": {
                        if (!body?.title || !body?.content) throw new Error("title and content are required");
                        const result = await kb_create(body);
                        res.writeHead(200, { "Content-Type": "application/json" });
                        res.end(JSON.stringify(result));
                        return;
                    }
                    case "DELETE": {
                        if (!search_params.id) throw new Error("id is required");
                        await kb_delete({ id: search_params.id });
                        res.writeHead(200, { "Content-Type": "application/json" });
                        res.end(JSON.stringify({ message: "Document deleted" }));
                        return;
                    }
                    case "PATCH": {
                        if (!search_params.id) throw new Error("id is required");
                        await kb_toggle({ id: search_params.id, is_active: body?.is_active ?? true });
                        res.writeHead(200, { "Content-Type": "application/json" });
                        res.end(JSON.stringify({ message: "Document updated" }));
                        return;
                    }
                    default:
                        throw new Error(`Method not allowed: ${req.method}`);
                }
            }
            case "/api/kb/tags": {
                switch (req.method?.toUpperCase()) {
                    case "GET": {
                        const result = await tag_list();
                        res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
                        res.end(JSON.stringify(result));
                        return;
                    }
                    case "POST": {
                        if (!await requireAuth(req, res)) return;
                        const userEmail: string = (req as any).userEmail;
                        if (!body?.name) throw new Error("name is required");
                        const tag = await tag_create(body, userEmail);
                        res.writeHead(201, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
                        res.end(JSON.stringify(tag));
                        return;
                    }
                    default:
                        throw new Error(`Method not allowed: ${req.method}`);
                }
            }
            case "/api/voice-agent/status": {
                if (req.method?.toUpperCase() !== "GET") throw new Error(`Method not allowed: ${req.method}`);

                handleVoiceAgentStatus(req, res);
                return;
            }
            case "/api/bot-settings": {
                switch (req.method?.toUpperCase()) {
                    case "GET": {
                        const settings = await bot_settings_get();
                        res.writeHead(200, { "Content-Type": "application/json" });
                        res.end(JSON.stringify(settings));
                        return;
                    }
                    case "PATCH": {
                        const updated = await bot_settings_update(body ?? {});
                        res.writeHead(200, { "Content-Type": "application/json" });
                        res.end(JSON.stringify(updated));
                        return;
                    }
                    default:
                        throw new Error(`Method not allowed: ${req.method}`);
                }
            }
            case "/api/voice-agent-config/photo": {
                switch (req.method?.toUpperCase()) {
                    case "POST": {
                        if (!body?.image || !body?.content_type) {
                            throw new Error("image (base64) and content_type are required");
                        }
                        const result = await voice_agent_photo_upload(body);
                        res.writeHead(200, { "Content-Type": "application/json" });
                        res.end(JSON.stringify(result));
                        return;
                    }
                    case "DELETE": {
                        await voice_agent_photo_delete();
                        res.writeHead(200, { "Content-Type": "application/json" });
                        res.end(JSON.stringify({ message: "Photo removed" }));
                        return;
                    }
                    default:
                        throw new Error(`Method not allowed: ${req.method}`);
                }
            }
            case "/api/voice-agent-config": {
                switch (req.method?.toUpperCase()) {
                    case "GET": {
                        const config = await voice_agent_config_get();
                        res.writeHead(200, { "Content-Type": "application/json" });
                        res.end(JSON.stringify(config));
                        return;
                    }
                    case "PATCH": {
                        const updated = await voice_agent_config_update(body ?? {});
                        res.writeHead(200, { "Content-Type": "application/json" });
                        res.end(JSON.stringify(updated));
                        return;
                    }
                    default:
                        throw new Error(`Method not allowed: ${req.method}`);
                }
            }
            case "/api/bot/join": {
                if (req.method?.toUpperCase() !== "POST") throw new Error(`Method not allowed: ${req.method}`);
                if (!await requireAuth(req, res)) return;
                if (!body?.meeting_url) throw new Error("meeting_url is required");

                const userEmail: string | undefined = (req as any).userEmail;
                if (!userEmail) {
                    res.writeHead(401, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ error: "Unable to resolve user email from auth token" }));
                    return;
                }

                // Use persisted bot_type from settings when caller doesn't specify one
                let bot_type = body.bot_type;
                if (!bot_type) {
                    const settings = await bot_settings_get();
                    bot_type = settings.bot_mode === "voice_agent" ? "voice_agent" : "recording";
                }

                const result = await bot_join({ ...body, bot_type, user_email: userEmail });
                console.log(`Ad-hoc bot created: ${JSON.stringify(result)}`);

                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify(result));
                return;
            }
            case "/api/calendar/events/bot": {
                switch (req.method?.toUpperCase()) {
                    // Scheudle a bot for a given calendar event.
                    case "POST": {
                        if (!await requireAuth(req, res)) return;
                        if (!search_params.calendar_event_id) throw new Error("calendar_event_id is required");

                        const bot_type = (search_params.bot_type === "voice_agent") ? "voice_agent" : "recording";
                        const tag_ids: string[] = Array.isArray(body?.tag_ids) ? body.tag_ids : [];

                        const calendar_event = await calendar_event_retrieve({ calendar_event_id: search_params.calendar_event_id });
                        if (!calendar_event) throw new Error("Calendar event not found");

                        const calendar = await calendar_retrieve({ calendar_id: calendar_event.calendar_id });
                        if (!calendar) throw new Error("Calendar not found");

                        const results = await schedule_bot_for_calendar_event({ calendar, calendar_event, bot_type });
                        console.log(`Scheduled Bot for Calendar Event: ${JSON.stringify(results)}`);

                        if (tag_ids.length > 0) {
                            await supabase.from("calendar_event_tags").upsert({
                                calendar_event_id: search_params.calendar_event_id,
                                tag_ids,
                            });
                        }

                        res.writeHead(200, { "Content-Type": "application/json" });
                        res.end(JSON.stringify({ message: "Bot scheduled" }));
                        return;
                    }
                    // Unschedule a bot for a given calendar event.
                    case "DELETE": {
                        if (!await requireAuth(req, res)) return;
                        if (!search_params.calendar_event_id) throw new Error("calendar_event_id is required");

                        const bot_type = (search_params.bot_type === "voice_agent") ? "voice_agent" : "recording";

                        const calendar_event = await calendar_event_retrieve({ calendar_event_id: search_params.calendar_event_id });
                        if (!calendar_event) throw new Error("Calendar event not found");

                        const calendar = await calendar_retrieve({ calendar_id: calendar_event.calendar_id });
                        if (!calendar) throw new Error("Calendar not found");

                        // İlgili bot'un dedup key'ini bul — bots[] array'inden prefix'e göre eşleştir
                        const dedup_prefix = bot_type === "voice_agent" ? "va-" : "rec-";
                        const target_bot = calendar_event.bots.find(b => b.deduplication_key.startsWith(dedup_prefix));

                        const results = await unschedule_bot_for_calendar_event({
                            calendar_event_id: search_params.calendar_event_id,
                            deduplication_key: target_bot?.deduplication_key,
                        });
                        console.log(`Unscheduled Bot for Calendar Event: ${JSON.stringify(results)}`);

                        res.writeHead(200, { "Content-Type": "application/json" });
                        res.end(JSON.stringify({ message: "Bot unscheduled" }));
                        return;
                    }
                    default: {
                        throw new Error(`Method not allowed: ${req.method}`);
                    }
                }
            }

            case "/api/calendar/events/tag": {
                if (req.method?.toUpperCase() !== "PUT") throw new Error(`Method not allowed: ${req.method}`);
                if (!await requireAuth(req, res)) return;
                if (!body?.calendar_event_id) throw new Error("calendar_event_id is required");
                if (!Array.isArray(body?.tag_ids)) throw new Error("tag_ids array is required");

                await supabase.from("calendar_event_tags").upsert({
                    calendar_event_id: body.calendar_event_id,
                    tag_ids: body.tag_ids,
                });

                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ message: "Tags saved" }));
                return;
            }

            /** Default endpoints */
            default: {

                // ── /api/meetings/:botId/allowed-tags — relay API key auth ──────
                if (pathname.match(/^\/api\/meetings\/[^/]+\/allowed-tags$/)) {
                    const apiKey = req.headers["x-api-key"];
                    const expectedKey = process.env.BACKEND_API_KEY;
                    if (!expectedKey || apiKey !== expectedKey) {
                        res.writeHead(401, { "Content-Type": "application/json" });
                        res.end(JSON.stringify({ error: "Unauthorized" }));
                        return;
                    }
                    if (req.method?.toUpperCase() !== "GET") throw new Error(`Method not allowed: ${req.method}`);
                    const botId = pathname.split("/")[3]!;
                    const result = await meeting_allowed_tags({ botId });
                    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
                    res.end(JSON.stringify(result));
                    return;
                }

                // ── /api/meetings/:botId/tags — per-meeting tag assignment ─────
                if (pathname.match(/^\/api\/meetings\/[^/]+\/tags$/)) {
                    const botId = pathname.split("/")[3]!;
                    if (!await requireAuth(req, res)) return;
                    if (req.method?.toUpperCase() === "GET") {
                        const result = await meeting_tags_get({ botId });
                        res.writeHead(200, { "Content-Type": "application/json" });
                        res.end(JSON.stringify(result));
                        return;
                    }
                    if (req.method?.toUpperCase() === "PUT") {
                        if (!Array.isArray(body?.tag_ids)) throw new Error("tag_ids array is required");
                        const result = await meeting_tags_set({ botId, tag_ids: body.tag_ids });
                        res.writeHead(200, { "Content-Type": "application/json" });
                        res.end(JSON.stringify(result));
                        return;
                    }
                    throw new Error(`Method not allowed: ${req.method}`);
                }

                // ── /api/kb/retry/:botId — re-trigger KB ingestion ────────────
                if (pathname.match(/^\/api\/kb\/retry\/[^/]+$/)) {
                    const botId = pathname.replace("/api/kb/retry/", "");
                    if (req.method?.toUpperCase() !== "POST") throw new Error(`Method not allowed: ${req.method}`);
                    if (!await requireAuth(req, res)) return;
                    const result = await kb_retry_ingestion({ botId });
                    res.writeHead(200, { "Content-Type": "application/json" });
                    res.end(JSON.stringify(result));
                    return;
                }

                // ── /api/kb/tags/:id — tag update / delete ────────────────────
                if (pathname.startsWith("/api/kb/tags/")) {
                    const tagId = pathname.replace("/api/kb/tags/", "");
                    switch (req.method?.toUpperCase()) {
                        case "PATCH": {
                            if (!await requireAuth(req, res)) return;
                            const tag = await tag_update(tagId, body ?? {});
                            res.writeHead(200, { "Content-Type": "application/json" });
                            res.end(JSON.stringify(tag));
                            return;
                        }
                        case "DELETE": {
                            if (!await requireAuth(req, res)) return;
                            await tag_delete(tagId);
                            res.writeHead(200, { "Content-Type": "application/json" });
                            res.end(JSON.stringify({ message: "Tag deleted" }));
                            return;
                        }
                        default:
                            throw new Error(`Method not allowed: ${req.method}`);
                    }
                }

                // ── /api/kb/:docId/tags/:tagId — remove tag from document ─────
                // Must be checked before the generic /api/kb/:id handler
                if (pathname.match(/^\/api\/kb\/[^/]+\/tags\/[^/]+$/)) {
                    const parts = pathname.split("/"); // ["", "api", "kb", docId, "tags", tagId]
                    const docId = parts[3]!;
                    const tagId = parts[5]!;
                    if (req.method?.toUpperCase() !== "DELETE") throw new Error(`Method not allowed: ${req.method}`);
                    if (!await requireAuth(req, res)) return;
                    await doc_tag_remove(docId, tagId);
                    res.writeHead(200, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ message: "Tag removed" }));
                    return;
                }

                // ── /api/kb/:docId/tags — add tag to document ─────────────────
                if (pathname.match(/^\/api\/kb\/[^/]+\/tags$/)) {
                    const docId = pathname.split("/")[3]!;
                    if (req.method?.toUpperCase() !== "POST") throw new Error(`Method not allowed: ${req.method}`);
                    if (!await requireAuth(req, res)) return;
                    if (!body?.tag_id) throw new Error("tag_id is required");
                    await doc_tag_add(docId, body.tag_id);
                    res.writeHead(200, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ message: "Tag added" }));
                    return;
                }

                // ── Single KB Document routes: /api/kb/:id ────────────────────
                if (pathname.startsWith("/api/kb/") && pathname !== "/api/kb/") {
                    const docId = pathname.replace("/api/kb/", "");

                    switch (req.method?.toUpperCase()) {
                        case "GET": {
                            const doc = await kb_get({ id: docId });
                            res.writeHead(200, {
                                "Content-Type": "application/json",
                                "Access-Control-Allow-Origin": "*",
                            });
                            res.end(JSON.stringify(doc));
                            return;
                        }
                        case "PUT": {
                            if (!body?.title || !body?.content || !body?.category) {
                                throw new Error("title, category, and content are required");
                            }
                            const result = await kb_update({ id: docId, ...body });
                            res.writeHead(200, {
                                "Content-Type": "application/json",
                                "Access-Control-Allow-Origin": "*",
                            });
                            res.end(JSON.stringify(result));
                            return;
                        }
                        default:
                            throw new Error(`Method not allowed: ${req.method}`);
                    }
                }

                // GET /api/knowledge-bases — list active knowledge bases (summary fields only)
                if (pathname === "/api/knowledge-bases" && req.method?.toUpperCase() === "GET") {
                    const result = await knowledge_bases_list();
                    console.log(`Listed Knowledge Bases: ${result.knowledge_bases.length}`);

                    res.writeHead(200, {
                        "Content-Type": "application/json",
                        "Access-Control-Allow-Origin": "*",
                    });
                    res.end(JSON.stringify(result));
                    return;
                }

                // GET /api/knowledge-bases/:slug — full knowledge base by slug
                if (pathname.startsWith("/api/knowledge-bases/") && req.method?.toUpperCase() === "GET") {
                    const slug = pathname.replace("/api/knowledge-bases/", "");
                    if (!slug) throw new Error("slug is required");

                    const kb = await knowledge_base_by_slug(slug);
                    if (!kb) {
                        res.writeHead(404, {
                            "Content-Type": "application/json",
                            "Access-Control-Allow-Origin": "*",
                        });
                        res.end(JSON.stringify({ error: "Knowledge base not found" }));
                        return;
                    }

                    console.log(`Retrieved Knowledge Base: ${kb.name}`);
                    res.writeHead(200, {
                        "Content-Type": "application/json",
                        "Access-Control-Allow-Origin": "*",
                    });
                    res.end(JSON.stringify(kb));
                    return;
                }

                // GET /api/notes — enriched meetings list (titles + participants) for Notes page
                if (pathname === "/api/notes" && req.method?.toUpperCase() === "GET") {
                    if (!await requireAuth(req, res)) return;
                    const userEmail: string = (req as any).userEmail;
                    const result = await handleNotesList(userEmail);
                    console.log(`Listed Notes for ${userEmail}: ${result.meetings.length} meetings`);

                    res.writeHead(200, {
                        "Content-Type": "application/json",
                        "Access-Control-Allow-Origin": "*",
                    });
                    res.end(JSON.stringify(result));
                    return;
                }

                // GET /api/notes/:botId — enriched transcript for Notes detail page
                if (pathname.startsWith("/api/notes/") && req.method?.toUpperCase() === "GET") {
                    if (!await requireAuth(req, res)) return;
                    const userEmail: string = (req as any).userEmail;
                    const botId = pathname.replace("/api/notes/", "");
                    if (!botId) throw new Error("botId is required");

                    const result = await handleNoteDetail(botId, userEmail);
                    console.log(`Retrieved note detail for bot ${botId}: ${result.utterances.length} utterances`);

                    res.writeHead(200, {
                        "Content-Type": "application/json",
                        "Access-Control-Allow-Origin": "*",
                    });
                    res.end(JSON.stringify(result));
                    return;
                }

                // PATCH /api/notes/:botId — update meeting title
                if (pathname.startsWith("/api/notes/") && req.method?.toUpperCase() === "PATCH") {
                    if (!await requireAuth(req, res)) return;
                    const userEmail: string = (req as any).userEmail;
                    const botId = pathname.replace("/api/notes/", "");
                    if (!botId) throw new Error("botId is required");

                    const result = await handleMeetingTitleUpdate(botId, userEmail, body?.title);
                    console.log(`Updated meeting title for bot ${botId}: "${result.title}"`);

                    res.writeHead(200, {
                        "Content-Type": "application/json",
                        "Access-Control-Allow-Origin": "*",
                    });
                    res.end(JSON.stringify(result));
                    return;
                }

                // GET /api/transcripts — all meetings
                if (pathname === "/api/transcripts" && req.method?.toUpperCase() === "GET") {
                    const { data } = await supabase
                        .from("meetings")
                        .select("bot_id, bot_type, meeting_url, done, created_at")
                        .order("created_at", { ascending: false });

                    // Group rows by meeting_url so that a meeting with both a recording bot and a
                    // voice_agent bot surfaces as a single entry — preferring the voice_agent bot_id.
                    // Rows without a meeting_url (e.g. in-progress calendar bots) are kept as-is.
                    type Row = { bot_id: string; bot_type: string | null; meeting_url: string | null; done: boolean; created_at: string };
                    const rows: Row[] = data ?? [];
                    const grouped = new Map<string, Row>();
                    for (const row of rows) {
                        const key = row.meeting_url ?? row.bot_id; // ungrouped rows use their own bot_id as key
                        const existing = grouped.get(key);
                        if (!existing || row.bot_type === "voice_agent") {
                            grouped.set(key, row);
                        }
                    }
                    const meetings = [...grouped.values()];

                    res.writeHead(200, {
                        "Content-Type": "application/json",
                        "Access-Control-Allow-Origin": "*",
                    });
                    res.end(JSON.stringify({ meetings }));
                    return;
                }

                // GET /api/transcripts/:botId
                if (pathname.startsWith("/api/transcripts/") && req.method?.toUpperCase() === "GET") {
                    const botId = pathname.replace("/api/transcripts/", "");
                    if (!botId) throw new Error("botId is required");

                    const transcript = await handleGetTranscript(botId);
                    console.log(`Retrieved transcript for bot ${botId}: ${transcript.utterances.length} utterances`);

                    res.writeHead(200, {
                        "Content-Type": "application/json",
                        "Access-Control-Allow-Origin": "*",
                    });
                    res.end(JSON.stringify(transcript));
                    return;
                }

                // GET /api/meeting-kb/:calendarEventId — per-meeting KB override
                if (pathname.startsWith("/api/meeting-kb/") && req.method?.toUpperCase() === "GET") {
                    const calendarEventId = pathname.replace("/api/meeting-kb/", "");
                    if (!calendarEventId) throw new Error("calendarEventId is required");
                    const result = await meeting_kb_get(calendarEventId);
                    res.writeHead(200, { "Content-Type": "application/json" });
                    res.end(JSON.stringify(result));
                    return;
                }

                // PUT /api/meeting-kb/:calendarEventId — upsert per-meeting KB override
                if (pathname.startsWith("/api/meeting-kb/") && req.method?.toUpperCase() === "PUT") {
                    const calendarEventId = pathname.replace("/api/meeting-kb/", "");
                    if (!calendarEventId) throw new Error("calendarEventId is required");
                    if (!body?.kb_document_id) throw new Error("kb_document_id is required");
                    await meeting_kb_upsert(calendarEventId, body.kb_document_id);
                    res.writeHead(200, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ message: "Override saved" }));
                    return;
                }

                // DELETE /api/meeting-kb/:calendarEventId — remove per-meeting KB override
                if (pathname.startsWith("/api/meeting-kb/") && req.method?.toUpperCase() === "DELETE") {
                    const calendarEventId = pathname.replace("/api/meeting-kb/", "");
                    if (!calendarEventId) throw new Error("calendarEventId is required");
                    await meeting_kb_delete(calendarEventId);
                    res.writeHead(200, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ message: "Override removed" }));
                    return;
                }

                if (url.pathname.startsWith("/api/")) {
                    throw new Error(`Endpoint not found: ${req.method} ${url.pathname}`);
                } else {
                    res.writeHead(404, { "Content-Type": "text/plain" });
                    res.end(Buffer.from(""));
                    return;
                }
            }
        }
    } catch (error) {
        console.error(`${req.method} ${req.url}`, error);
        const statusCode = (error as any)?.statusCode ?? 400;
        res.writeHead(statusCode, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : error }));
    }
});

/**
 * Start the server
 */
server.listen(env.PORT, "0.0.0.0", () => {
    const domain = env.RAILWAY_DOMAIN;
    console.log(`

Server running on port ${env.PORT}
Backend URL: https://${domain}
Frontend URL: ${client_domain}

OAuth URLs:
- Google: https://${domain}/api/calendar/oauth?platform=google_calendar
- Outlook: https://${domain}/api/calendar/oauth?platform=microsoft_outlook

Ensure that:
- The redirect URI in your Google/Outlook Calendar OAuth is set to: https://${domain}/api/calendar/oauth/callback
    `);
});
