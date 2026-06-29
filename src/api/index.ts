import http from "http";
import dotenv from "dotenv";
import { env } from "./config/env";
import { calendar_events_list } from "./handlers/calendar_events_list";
import { calendar_oauth } from "./handlers/calendar_oauth";
import { calendar_oauth_callback } from "./handlers/calendar_oauth_callback";
import { calendars_delete } from "./handlers/calendars_delete";
import { calendars_list } from "./handlers/calendars_list";
import { calendar_event_retrieve, calendar_retrieve, recall_webhook, schedule_bot_for_calendar_event, unschedule_bot_for_calendar_event, kb_retry_ingestion } from "./handlers/recall_webhook";

import { kb_list, kb_list_transcripts, kb_create, kb_delete, kb_toggle, kb_get, kb_update, tag_list, tag_create, tag_update, tag_delete, doc_tag_add, doc_tag_remove, meeting_tags_get, meeting_tags_set, meeting_allowed_tags } from "./handlers/knowledge_base";

import { handleTranscriptWebhook, handleGetTranscript } from "./handlers/transcript_webhook";
import { handleNotesList, handleNoteDetail, handleMeetingTitleUpdate } from "./handlers/notes";
import { handleVoiceAgentStatus } from "./handlers/voice_agent_status";
import { bot_join } from "./handlers/bot_join";
import { bot_settings_get, bot_settings_update } from "./handlers/bot_settings";
import { voice_agent_config_get, voice_agent_config_update } from "./handlers/voice_agent_config";
import { voice_agent_photo_upload, voice_agent_photo_delete } from "./handlers/voice_agent_photo";
import { knowledge_bases_list, knowledge_base_by_slug } from "./handlers/knowledge_bases";
import { meeting_kb_get, meeting_kb_upsert, meeting_kb_delete } from "./handlers/meeting_kb_override";
import { meeting_project_get, meeting_project_upsert, meeting_project_delete } from "./handlers/meeting_project";
import { project_list, project_create, project_get, project_update, project_delete, project_document_add, project_document_remove } from "./handlers/projects";
import { createInvite, getInvitation, acceptInvitation } from "./handlers/invitations";
import { getSharedProjects, getProjectMembers, removeMember, changeMemberRole, leaveProject } from "./handlers/projectMembers";
import { assertProjectAccess } from "./helpers/projectAccess";
import { supabaseAdmin, supabaseForUser } from "./config/supabase";
import { requireAuth } from "./middleware/auth";
import { verifyRecallRequest } from "./lib/verifyRecallRequest";

dotenv.config();

const server = http.createServer();
const client_domain = process.env.CLIENT_DOMAIN || "http://localhost:5173";

// Cookie attributes for the OAuth CSRF nonce (LIG-80). SameSite=Lax (not Strict) so the
// cookie survives Google's/Microsoft's top-level GET redirect back to the callback.
const OAUTH_STATE_COOKIE = "oauth_state";
const OAUTH_COOKIE_SET = (nonce: string) => `${OAUTH_STATE_COOKIE}=${nonce}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600`;
const OAUTH_COOKIE_CLEAR = `${OAUTH_STATE_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;

/**
 * Parse a single cookie value out of the raw Cookie header without adding a dependency.
 */
function parse_cookie(cookie_header: string | undefined, name: string): string | undefined {
    if (!cookie_header) return undefined;
    for (const part of cookie_header.split(";")) {
        const eq = part.indexOf("=");
        if (eq === -1) continue;
        if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
    }
    return undefined;
}

// Recall webhook verify-log throttle (LIG-81): transcript.data fires constantly, so a
// "pass" log on every event would flood the logs. Log a pass at most once per
// route+event key per window. Non-pass outcomes are always logged (never throttled).
const RECALL_VERIFY_LOG_THROTTLE_MS = 30_000;
const recall_verify_last_log = new Map<string, number>();
function should_log_recall_verify_pass(key: string): boolean {
    const now = Date.now();
    const last = recall_verify_last_log.get(key) ?? 0;
    if (now - last < RECALL_VERIFY_LOG_THROTTLE_MS) return false;
    recall_verify_last_log.set(key, now);
    return true;
}

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
        // raw_body is hoisted out of the try so webhook signature verification (LIG-81)
        // can hash the EXACT received bytes. It is assigned before JSON.parse, so even a
        // malformed body still yields the raw bytes for verification.
        let raw_body = "";
        try {
            if (["POST", "PUT", "PATCH", "DELETE"].includes(req.method!)) {
                const body_chunks: Buffer[] = [];
                for await (const chunk of req) {
                    body_chunks.push(chunk);
                }
                raw_body = Buffer.concat(body_chunks).toString("utf-8");
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

        // ── Recall webhook signature verification (LIG-81) ────────────────────────
        // Monitor mode by default: verify Recall's Svix-style signature on the two
        // Recall routes and log the outcome, but ALWAYS continue to dispatch. Enabling
        // RECALL_WEBHOOK_ENFORCE upgrades this to reject bad/unsigned requests with 401
        // — an env change only, no code change. Non-Recall routes are never touched.
        if (
            req.method?.toUpperCase() === "POST" &&
            (pathname === "/api/recall/webhook" || pathname === "/api/webhooks/transcript")
        ) {
            const secrets = [
                { name: "RECALL_WEBHOOK_SECRET", value: env.RECALL_WEBHOOK_SECRET },
                { name: "RECALL_SVIX_WEBHOOK_SECRET", value: env.RECALL_SVIX_WEBHOOK_SECRET },
            ].filter(
                (s): s is { name: string; value: string } =>
                    !!s.value && s.value.trim() !== "",
            );

            const verify = verifyRecallRequest({ rawBody: raw_body, headers: req.headers, secrets });
            const event: string = body?.event ?? "unknown";
            const enforce = env.RECALL_WEBHOOK_ENFORCE;

            if (verify.reason === "pass") {
                // Throttle the high-volume transcript.data pass logs; log other events' passes normally.
                if (event !== "transcript.data" || should_log_recall_verify_pass(`${pathname}:${event}`)) {
                    console.log(JSON.stringify({
                        tag: "recall_webhook_verify",
                        route: pathname,
                        event,
                        reason: verify.reason,
                        matched: verify.matched,
                        enforce,
                    }));
                }
            } else {
                console.warn(JSON.stringify({
                    tag: "recall_webhook_verify",
                    route: pathname,
                    event,
                    reason: verify.reason,
                    enforce,
                }));
            }

            // Operator misconfiguration: enforcement requested but no secret configured.
            // FAIL OPEN so a missing secret never blackholes production — just log loudly.
            if (verify.reason === "no_secret" && enforce) {
                console.error(JSON.stringify({
                    tag: "recall_webhook_verify",
                    route: pathname,
                    event,
                    reason: "no_secret",
                    enforce,
                    message: "RECALL_WEBHOOK_ENFORCE is on but no secret is configured — failing open",
                }));
            }

            // Enforcement: reject only genuinely bad/unsigned requests, and only when a
            // secret is actually configured (no_secret fails open above; pass continues).
            if (enforce && (verify.reason === "invalid" || verify.reason === "missing_headers")) {
                res.writeHead(401, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: "Invalid webhook signature" }));
                return;
            }
        }

        switch (pathname) {
            /** OAuth endpoints */
            case "/api/calendar/oauth": {
                if (req.method?.toUpperCase() !== "GET") throw new Error(`Method not allowed: ${req.method}`);

                const calendar_oauth_url = await calendar_oauth(search_params);
                console.log(`Created Calendar OAuth URL: ${calendar_oauth_url.oauth_url.toString()}`);

                // Redirect to the Calendar OAuth URL and bind the CSRF nonce to the browser
                // via an httpOnly cookie, verified on the callback (LIG-80).
                res.writeHead(302, {
                    "Location": calendar_oauth_url.oauth_url.toString(),
                    "Set-Cookie": OAUTH_COOKIE_SET(calendar_oauth_url.state_nonce),
                });
                res.end();
                return;
            }
            case "/api/calendar/oauth/callback": {
                if (req.method?.toUpperCase() !== "GET") throw new Error(`Method not allowed: ${req.method}`);

                const cookie_nonce = parse_cookie(req.headers.cookie, OAUTH_STATE_COOKIE);
                const result = await calendar_oauth_callback({ ...search_params, cookie_nonce });

                // One-time use: clear the nonce cookie on both success and failure.
                if (!result.ok) {
                    console.warn(`Calendar OAuth callback rejected: ${result.reason}`);
                    res.writeHead(302, {
                        "Location": `${client_domain}/dashboard/calendar?error=oauth_state`,
                        "Set-Cookie": OAUTH_COOKIE_CLEAR,
                    });
                    res.end();
                    return;
                }

                console.log(`Created Calendar: ${JSON.stringify(result.calendar)}`);
                res.writeHead(302, {
                    "Location": `${client_domain}/dashboard/calendar`,
                    "Set-Cookie": OAUTH_COOKIE_CLEAR,
                });
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
                        if (!await requireAuth(req, res)) return;
                        const userEmail: string = (req as any).userEmail;
                        const results = await kb_list(userEmail);
                        res.writeHead(200, { "Content-Type": "application/json" });
                        res.end(JSON.stringify(results));
                        return;
                    }
                    case "POST": {
                        if (!await requireAuth(req, res)) return;
                        const userEmail: string = (req as any).userEmail;
                        if (!body?.title || !body?.content) throw new Error("title and content are required");
                        const result = await kb_create({ ...body, owner_user_id: userEmail });
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
                        if (!await requireAuth(req, res)) return;
                        const userEmail: string = (req as any).userEmail;
                        const result = await tag_list(userEmail);
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

                        let scheduled_count = 0;
                        if (body?.auto_join_enabled === true) {
                            try {
                                console.log("[bot-settings] auto_join_enabled turned ON — running catchup scan");
                                const { calendars: allCalendars } = await calendars_list({});

                                for (const calendar of allCalendars) {
                                    try {
                                        const now = new Date().toISOString();
                                        let next: string | null = null;
                                        do {
                                            const { calendar_events, next: newNext } = await calendar_events_list({
                                                calendar_id: calendar.id,
                                                next,
                                                start_time__gte: now,
                                                start_time__lte: null,
                                            });

                                            for (const event of calendar_events) {
                                                if (event.is_deleted) continue;
                                                if (!event.meeting_url || !event.start_time) continue;
                                                if (new Date(event.start_time) <= new Date()) continue;

                                                const bot_type = updated.bot_mode === "voice_agent" ? "voice_agent" : "recording";
                                                if (bot_type === "voice_agent" && (!env.VOICE_AGENT_PAGE_URL || !env.VOICE_AGENT_WSS_URL)) {
                                                    console.warn(`[catchup] voice_agent env vars missing — skipping event ${event.id}`);
                                                    continue;
                                                }

                                                try {
                                                    await schedule_bot_for_calendar_event({
                                                        calendar_event: event,
                                                        calendar,
                                                        bot_type,
                                                        kb_id: bot_type === "voice_agent" ? (updated.active_kb_id ?? undefined) : undefined,
                                                    });
                                                    scheduled_count++;
                                                    console.log(`[catchup] Scheduled ${bot_type} bot for event ${event.id}`);
                                                } catch (err) {
                                                    console.log(`[catchup] ${bot_type} bot for event ${event.id}: ${(err as Error).message?.slice(0, 100)}`);
                                                }
                                            }
                                            next = newNext;
                                        } while (next);
                                    } catch (calErr) {
                                        console.error(`[catchup] Failed to scan calendar ${calendar.id}:`, calErr);
                                    }
                                }
                                console.log(`[catchup] Done — scheduled ${scheduled_count} bots total`);
                            } catch (err) {
                                console.error("[catchup] Failed to run catchup scan:", err);
                            }
                        }

                        res.writeHead(200, { "Content-Type": "application/json" });
                        res.end(JSON.stringify({ ...updated, scheduled_count }));
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
                const userId: string = (req as any).userId;
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

                if (body.project_id) {
                    await assertProjectAccess({ projectId: body.project_id, userId, userEmail });
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

                        const calendar_event = await calendar_event_retrieve({ calendar_event_id: search_params.calendar_event_id });
                        if (!calendar_event) throw new Error("Calendar event not found");

                        const calendar = await calendar_retrieve({ calendar_id: calendar_event.calendar_id });
                        if (!calendar) throw new Error("Calendar not found");

                        const mpResult = await supabaseAdmin
                            .from("meeting_projects")
                            .select("project_id")
                            .eq("calendar_event_id", calendar_event.id)
                            .maybeSingle();
                        const project_id: string | undefined = mpResult.data?.project_id ?? undefined;
                        console.log(`[calendar/events/bot] calendar_event_id=${calendar_event.id} project_id=${project_id ?? "null"}`);

                        const results = await schedule_bot_for_calendar_event({ calendar, calendar_event, bot_type, project_id });
                        console.log(`Scheduled Bot for Calendar Event: ${JSON.stringify(results)}`);

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
                if (req.method?.toUpperCase() === "GET") {
                    if (!await requireAuth(req, res)) return;
                    const cal_event_id = search_params.calendar_event_id as string;
                    if (!cal_event_id) {
                        res.writeHead(400, { "Content-Type": "application/json" });
                        res.end(JSON.stringify({ error: "calendar_event_id required" }));
                        return;
                    }
                    const { data } = await supabaseForUser((req as any).userJwt)
                        .from("calendar_event_tags")
                        .select("tag_ids")
                        .eq("calendar_event_id", cal_event_id)
                        .maybeSingle();
                    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
                    res.end(JSON.stringify({ tag_ids: data?.tag_ids ?? null }));
                    return;
                }
                if (req.method?.toUpperCase() !== "PUT") break;
                if (!await requireAuth(req, res)) return;

                const { calendar_event_id: cal_evt_id, tag_ids: cal_tag_ids } = body ?? {};
                if (!cal_evt_id) {
                    res.writeHead(400, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ error: "calendar_event_id required" }));
                    return;
                }

                const { error: calTagErr } = await supabaseForUser((req as any).userJwt)
                    .from("calendar_event_tags")
                    .upsert({ calendar_event_id: cal_evt_id, tag_ids: cal_tag_ids ?? [] });

                if (calTagErr) {
                    res.writeHead(500, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ error: calTagErr.message }));
                    return;
                }

                res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
                res.end(JSON.stringify({ ok: true }));
                return;
            }
            /** Default endpoints */
            default: {

                // ── GET /api/relay/allowed-tags?token=... — resolve meetingToken → tag IDs ──
                if (pathname === "/api/relay/allowed-tags" && req.method?.toUpperCase() === "GET") {
                    const apiKey = req.headers["x-api-key"];
                    const expectedKey = process.env.BACKEND_API_KEY;
                    if (!expectedKey || apiKey !== expectedKey) {
                        res.writeHead(401, { "Content-Type": "application/json" });
                        res.end(JSON.stringify({ error: "Unauthorized" }));
                        return;
                    }
                    const token = search_params.token as string | undefined;
                    if (!token) {
                        res.writeHead(400, { "Content-Type": "application/json" });
                        res.end(JSON.stringify({ error: "token is required" }));
                        return;
                    }
                    const { data: meeting } = await supabaseAdmin
                        .from("meetings")
                        .select("bot_id")
                        .eq("meeting_token", token)
                        .single();
                    if (!meeting?.bot_id) {
                        res.writeHead(200, { "Content-Type": "application/json" });
                        res.end(JSON.stringify({ tag_ids: null }));
                        return;
                    }
                    const result = await meeting_allowed_tags({ botId: meeting.bot_id });
                    res.writeHead(200, { "Content-Type": "application/json" });
                    res.end(JSON.stringify(result));
                    return;
                }

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
                    const userEmail: string = (req as any).userEmail;
                    if (req.method?.toUpperCase() === "GET") {
                        const result = await meeting_tags_get({ botId, userEmail });
                        res.writeHead(200, { "Content-Type": "application/json" });
                        res.end(JSON.stringify(result));
                        return;
                    }
                    if (req.method?.toUpperCase() === "PUT") {
                        if (!Array.isArray(body?.tag_ids)) throw new Error("tag_ids array is required");
                        const result = await meeting_tags_set({ botId, tag_ids: body.tag_ids, userEmail });
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
                            const userEmail: string = (req as any).userEmail;
                            const tag = await tag_update(tagId, body ?? {}, userEmail);
                            res.writeHead(200, { "Content-Type": "application/json" });
                            res.end(JSON.stringify(tag));
                            return;
                        }
                        case "DELETE": {
                            if (!await requireAuth(req, res)) return;
                            const userEmail: string = (req as any).userEmail;
                            await tag_delete(tagId, userEmail);
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

                // ── GET /api/kb/transcripts — user-scoped transcript list ─────
                if (pathname === "/api/kb/transcripts" && req.method?.toUpperCase() === "GET") {
                    if (!await requireAuth(req, res)) return;
                    const userEmail: string = (req as any).userEmail;
                    const result = await kb_list_transcripts(userEmail);
                    res.writeHead(200, { "Content-Type": "application/json" });
                    res.end(JSON.stringify(result));
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
                    const { data } = await supabaseAdmin
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

                // ── /api/meeting-project — meeting→project assignment ─────
                if (pathname === "/api/meeting-project") {
                    switch (req.method?.toUpperCase()) {
                        case "GET": {
                            if (!await requireAuth(req, res)) return;
                            const userId: string = (req as any).userId;
                            const userEmail: string = (req as any).userEmail;
                            const result = await meeting_project_get(search_params, userId, userEmail);
                            res.writeHead(200, { "Content-Type": "application/json" });
                            res.end(JSON.stringify(result));
                            return;
                        }
                        case "PUT": {
                            if (!await requireAuth(req, res)) return;
                            const userId: string = (req as any).userId;
                            const userEmail: string = (req as any).userEmail;
                            const result = await meeting_project_upsert(body ?? {}, userId, userEmail);
                            res.writeHead(200, { "Content-Type": "application/json" });
                            res.end(JSON.stringify(result));
                            return;
                        }
                        case "DELETE": {
                            if (!await requireAuth(req, res)) return;
                            const userId: string = (req as any).userId;
                            const userEmail: string = (req as any).userEmail;
                            const result = await meeting_project_delete(search_params, userId, userEmail);
                            res.writeHead(200, { "Content-Type": "application/json" });
                            res.end(JSON.stringify(result));
                            return;
                        }
                        default:
                            throw new Error(`Method not allowed: ${req.method}`);
                    }
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

                // ── GET /api/projects/shared — projects where caller is a member ──
                // Must be matched BEFORE /api/projects/:id to avoid "shared" being captured as :id
                if (pathname === "/api/projects/shared" && req.method?.toUpperCase() === "GET") {
                    if (!await requireAuth(req, res)) return;
                    const userEmail: string = (req as any).userEmail;
                    const result = await getSharedProjects({ userEmail });
                    res.writeHead(200, { "Content-Type": "application/json" });
                    res.end(JSON.stringify(result));
                    return;
                }

                // ── /api/projects — list + create ─────────────────────────
                if (pathname === "/api/projects") {
                    switch (req.method?.toUpperCase()) {
                        case "GET": {
                            if (!await requireAuth(req, res)) return;
                            const userId: string = (req as any).userId;
                            const result = await project_list(userId);
                            res.writeHead(200, { "Content-Type": "application/json" });
                            res.end(JSON.stringify(result));
                            return;
                        }
                        case "POST": {
                            if (!await requireAuth(req, res)) return;
                            const userId: string = (req as any).userId;
                            if (!body?.name) {
                                res.writeHead(400, { "Content-Type": "application/json" });
                                res.end(JSON.stringify({ error: "name is required" }));
                                return;
                            }
                            const project = await project_create(body, userId);
                            res.writeHead(201, { "Content-Type": "application/json" });
                            res.end(JSON.stringify(project));
                            return;
                        }
                        default:
                            throw new Error(`Method not allowed: ${req.method}`);
                    }
                }

                // ── /api/projects/:id — get, update, delete ────────────────
                if (pathname.match(/^\/api\/projects\/[^/]+$/)) {
                    const projectId = pathname.split("/")[3]!;
                    switch (req.method?.toUpperCase()) {
                        case "GET": {
                            if (!await requireAuth(req, res)) return;
                            const userId: string = (req as any).userId;
                            const userEmail: string = (req as any).userEmail;
                            const result = await project_get(projectId, userId, userEmail);
                            res.writeHead(200, { "Content-Type": "application/json" });
                            res.end(JSON.stringify(result));
                            return;
                        }
                        case "PATCH": {
                            if (!await requireAuth(req, res)) return;
                            const userId: string = (req as any).userId;
                            const userEmail: string = (req as any).userEmail;
                            const result = await project_update(projectId, body ?? {}, userId, userEmail);
                            res.writeHead(200, { "Content-Type": "application/json" });
                            res.end(JSON.stringify(result));
                            return;
                        }
                        case "DELETE": {
                            if (!await requireAuth(req, res)) return;
                            const userId: string = (req as any).userId;
                            const userEmail: string = (req as any).userEmail;
                            await project_delete(projectId, userId, userEmail);
                            res.writeHead(200, { "Content-Type": "application/json" });
                            res.end(JSON.stringify({ message: "Project deleted" }));
                            return;
                        }
                        default:
                            throw new Error(`Method not allowed: ${req.method}`);
                    }
                }

                // ── /api/projects/:id/documents/:docId — remove document ──
                if (pathname.match(/^\/api\/projects\/[^/]+\/documents\/[^/]+$/)) {
                    if (req.method?.toUpperCase() !== "DELETE") throw new Error(`Method not allowed: ${req.method}`);
                    if (!await requireAuth(req, res)) return;
                    const userId: string = (req as any).userId;
                    const userEmail: string = (req as any).userEmail;
                    const projectId = pathname.split("/")[3]!;
                    const docId = pathname.split("/")[5]!;
                    const result = await project_document_remove(projectId, docId, userId, userEmail, search_params.bot_id);
                    res.writeHead(200, { "Content-Type": "application/json" });
                    res.end(JSON.stringify(result));
                    return;
                }

                // ── /api/projects/:id/documents — add document ────────────
                if (pathname.match(/^\/api\/projects\/[^/]+\/documents$/)) {
                    if (req.method?.toUpperCase() !== "POST") throw new Error(`Method not allowed: ${req.method}`);
                    if (!await requireAuth(req, res)) return;
                    const userId: string = (req as any).userId;
                    const userEmail: string = (req as any).userEmail;
                    const projectId = pathname.split("/")[3]!;
                    if (!body?.document_id) {
                        res.writeHead(400, { "Content-Type": "application/json" });
                        res.end(JSON.stringify({ error: "document_id is required" }));
                        return;
                    }
                    const result = await project_document_add(projectId, body.document_id, userId, userEmail);
                    res.writeHead(200, { "Content-Type": "application/json" });
                    res.end(JSON.stringify(result));
                    return;
                }

                // ── POST /api/projects/:id/invite — generate invite link ──
                if (pathname.match(/^\/api\/projects\/[^/]+\/invite$/) && req.method?.toUpperCase() === "POST") {
                    if (!await requireAuth(req, res)) return;
                    const projectId = pathname.split("/")[3]!;
                    const userId: string = (req as any).userId;
                    const userEmail: string = (req as any).userEmail;
                    await assertProjectAccess({ projectId, userId, userEmail, requiredRole: "admin" });
                    const result = await createInvite({ projectId, userId, userEmail, invitedEmail: body?.email, role: body?.role });
                    res.writeHead(201, { "Content-Type": "application/json" });
                    res.end(JSON.stringify(result));
                    return;
                }

                // ── GET /api/invitations/:token — resolve invite metadata ─
                if (pathname.match(/^\/api\/invitations\/[^/]+$/) && req.method?.toUpperCase() === "GET") {
                    const token = pathname.split("/")[3]!;
                    const result = await getInvitation({ token });
                    res.writeHead(200, { "Content-Type": "application/json" });
                    res.end(JSON.stringify(result));
                    return;
                }

                // ── POST /api/invitations/:token/accept — accept invite ───
                if (pathname.match(/^\/api\/invitations\/[^/]+\/accept$/) && req.method?.toUpperCase() === "POST") {
                    if (!await requireAuth(req, res)) return;
                    const token = pathname.split("/")[3]!;
                    const userId: string = (req as any).userId;
                    const userEmail: string = (req as any).userEmail;
                    const result = await acceptInvitation({ token, userId, userEmail });
                    res.writeHead(200, { "Content-Type": "application/json" });
                    res.end(JSON.stringify(result));
                    return;
                }

                // ── GET /api/projects/:id/members — list project members ──
                if (pathname.match(/^\/api\/projects\/[^/]+\/members$/) && req.method?.toUpperCase() === "GET") {
                    if (!await requireAuth(req, res)) return;
                    const projectId = pathname.split("/")[3]!;
                    const userId: string = (req as any).userId;
                    const userEmail: string = (req as any).userEmail;
                    const result = await getProjectMembers({ projectId, userId, userEmail });
                    res.writeHead(200, { "Content-Type": "application/json" });
                    res.end(JSON.stringify(result));
                    return;
                }

                // ── PATCH /api/projects/:id/members/:email — admin changes member role ──
                if (pathname.match(/^\/api\/projects\/[^/]+\/members\/[^/]+$/) && req.method?.toUpperCase() === "PATCH") {
                    if (!await requireAuth(req, res)) return;
                    const parts = pathname.split("/");
                    const projectId = parts[3]!;
                    const targetEmail = decodeURIComponent(parts[5]!);
                    const userId: string = (req as any).userId;
                    const userEmail: string = (req as any).userEmail;
                    await assertProjectAccess({ projectId, userId, userEmail, requiredRole: "admin" });
                    const result = await changeMemberRole({ projectId, targetEmail, newRole: body?.role });
                    res.writeHead(200, { "Content-Type": "application/json" });
                    res.end(JSON.stringify(result));
                    return;
                }

                // ── DELETE /api/projects/:id/members/:email — owner removes member ──
                if (pathname.match(/^\/api\/projects\/[^/]+\/members\/[^/]+$/) && req.method?.toUpperCase() === "DELETE") {
                    if (!await requireAuth(req, res)) return;
                    const parts = pathname.split("/");
                    const projectId = parts[3]!;
                    const targetEmail = decodeURIComponent(parts[5]!);
                    const userId: string = (req as any).userId;
                    const userEmail: string = (req as any).userEmail;
                    const result = await removeMember({ projectId, userId, userEmail, targetEmail });
                    res.writeHead(200, { "Content-Type": "application/json" });
                    res.end(JSON.stringify(result));
                    return;
                }

                // ── POST /api/projects/:id/leave — member leaves a project ──
                if (pathname.match(/^\/api\/projects\/[^/]+\/leave$/) && req.method?.toUpperCase() === "POST") {
                    if (!await requireAuth(req, res)) return;
                    const projectId = pathname.split("/")[3]!;
                    const userId: string = (req as any).userId;
                    const userEmail: string = (req as any).userEmail;
                    const result = await leaveProject({ projectId, userId, userEmail });
                    res.writeHead(200, { "Content-Type": "application/json" });
                    res.end(JSON.stringify(result));
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
