import http from "http";
import dotenv from "dotenv";
import { env } from "./config/env";
import { calendar_events_list } from "./handlers/calendar_events_list";
import { calendar_oauth } from "./handlers/calendar_oauth";
import { calendar_oauth_callback } from "./handlers/calendar_oauth_callback";
import { calendars_delete } from "./handlers/calendars_delete";
import { calendars_list } from "./handlers/calendars_list";
import { calendar_event_retrieve, calendar_retrieve, recall_webhook, schedule_bot_for_calendar_event, unschedule_bot_for_calendar_event } from "./handlers/recall_webhook";
import { kb_list, kb_create, kb_delete, kb_toggle } from "./handlers/knowledge_base";
import { handleTranscriptWebhook, handleGetTranscript } from "./handlers/transcript_webhook";
import { handleVoiceAgentStatus } from "./handlers/voice_agent_status";
import { bot_join } from "./handlers/bot_join";
import { bot_settings_get, bot_settings_update } from "./handlers/bot_settings";
import { knowledge_bases_list, knowledge_base_by_slug } from "./handlers/knowledge_bases";
import { supabase } from "./config/supabase";

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
                "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
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
                        // platform_email artık opsiyonel — verilmezse tüm takvimler döner
                        const results = await calendars_list(search_params);
                        console.log(`Listed Calendars: ${JSON.stringify(results)}`);

                        res.writeHead(200, { "Content-Type": "application/json" });
                        res.end(JSON.stringify(results));
                        return;
                    }
                    /** Delete calendar */
                    case "DELETE": {
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
            case "/api/bot/join": {
                if (req.method?.toUpperCase() !== "POST") throw new Error(`Method not allowed: ${req.method}`);
                if (!body?.meeting_url) throw new Error("meeting_url is required");

                // Use persisted bot_type from settings when caller doesn't specify one
                let bot_type = body.bot_type;
                if (!bot_type) {
                    const settings = await bot_settings_get();
                    bot_type = settings.bot_mode === "voice_agent" ? "voice_agent" : "recording";
                }

                const result = await bot_join({ ...body, bot_type });
                console.log(`Ad-hoc bot created: ${JSON.stringify(result)}`);

                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify(result));
                return;
            }
            case "/api/calendar/events/bot": {
                switch (req.method?.toUpperCase()) {
                    // Scheudle a bot for a given calendar event.
                    case "POST": {
                        if (!search_params.calendar_event_id) throw new Error("calendar_event_id is required");

                        const bot_type = (search_params.bot_type === "voice_agent") ? "voice_agent" : "recording";

                        const calendar_event = await calendar_event_retrieve({ calendar_event_id: search_params.calendar_event_id });
                        if (!calendar_event) throw new Error("Calendar event not found");

                        const calendar = await calendar_retrieve({ calendar_id: calendar_event.calendar_id });
                        if (!calendar) throw new Error("Calendar not found");

                        const results = await schedule_bot_for_calendar_event({ calendar, calendar_event, bot_type });
                        console.log(`Scheduled Bot for Calendar Event: ${JSON.stringify(results)}`);

                        res.writeHead(200, { "Content-Type": "application/json" });
                        res.end(JSON.stringify({ message: "Bot scheduled" }));
                        return;
                    }
                    // Unschedule a bot for a given calendar event.
                    case "DELETE": {
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

            /** Default endpoints */
            default: {
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

                // GET /api/transcripts — all meetings
                if (pathname === "/api/transcripts" && req.method?.toUpperCase() === "GET") {
                    const { data } = await supabase
                        .from("meetings")
                        .select("bot_id, done, created_at")
                        .order("created_at", { ascending: false });

                    res.writeHead(200, {
                        "Content-Type": "application/json",
                        "Access-Control-Allow-Origin": "*",
                    });
                    res.end(JSON.stringify({ meetings: data ?? [] }));
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
        res.writeHead(400, { "Content-Type": "application/json" });
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
