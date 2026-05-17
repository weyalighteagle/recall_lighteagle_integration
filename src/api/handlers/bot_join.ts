import { z } from "zod";
import { randomUUID } from "crypto";
import { env } from "../config/env";
import { supabase } from "../config/supabase";
import { bot_settings_get } from "./bot_settings.js";
import { meeting_tags_set } from "./knowledge_base.js";

/**
 * Doğrudan meeting URL'si ile ad-hoc bot gönder.
 * Takvim event'i gerekmez — URL yeter.
 *
 * @param bot_type - "recording" (default) sends a standard transcript bot.
 *                   "voice_agent" sends an Output Media bot that renders a webpage
 *                   via VOICE_AGENT_PAGE_URL/VOICE_AGENT_WSS_URL and also captures
 *                   transcript via recallai_streaming. Requires both env vars to be set.
 */
export async function bot_join(args: {
    meeting_url: string;
    bot_name?: string;
    bot_type?: "recording" | "voice_agent";
    user_email: string;   // required — caller must extract from Clerk auth before calling
    project_id?: string;
}) {
    const { meeting_url, bot_name } = z.object({
        meeting_url: z.string().url(),
        bot_name: z.string().optional(),
    }).parse(args);

    const botType: "recording" | "voice_agent" = args.bot_type ?? "recording";

    if (botType === "voice_agent") {
        if (!env.VOICE_AGENT_PAGE_URL || !env.VOICE_AGENT_WSS_URL) {
            throw Object.assign(
                new Error("Voice agent not configured — VOICE_AGENT_PAGE_URL and VOICE_AGENT_WSS_URL must be set"),
                { statusCode: 400 },
            );
        }
    }

    let payload: Record<string, any>;

    // Pre-generate a token so we can embed it in the camera URL before the Recall.ai
    // API call (bot.id is not known until after creation, so we can't use it directly).
    // The relay reads this token from the WebSocket URL and resolves it to allowed tag IDs.
    const meetingToken = botType === "voice_agent" ? randomUUID() : null;

    if (botType === "voice_agent") {
        console.log(`[bot_join] project_id from args: ${args.project_id}`);
        const output_media_url = `${env.VOICE_AGENT_PAGE_URL}?meetingToken=${meetingToken}&wss=${encodeURIComponent(env.VOICE_AGENT_WSS_URL!)}${args.project_id ? `&project=${encodeURIComponent(args.project_id)}` : ""}`;
        console.log(`[bot_join] output_media_url: ${output_media_url}`);

        payload = {
            meeting_url,
            bot_name: bot_name || "WEYA Voice Agent",
            variant: {
                zoom: "web_4_core",
                google_meet: "web_4_core",
                microsoft_teams: "web_4_core",
            },
            output_media: {
                camera: {
                    kind: "webpage",
                    config: {
                        url: output_media_url,
                    },
                },
            },
            recording_config: {
                transcript: {
                    provider: {
                        recallai_streaming: {
                            language: "tr",
                        },
                    },
                },
                realtime_endpoints: [
                    {
                        type: "webhook",
                        url: `https://${env.RAILWAY_DOMAIN}/api/webhooks/transcript`,
                        events: ["transcript.data", "transcript.partial_data"],
                    },
                ],
                include_bot_in_recording: {
                    audio: true,
                },
            },
        };
    } else {
        payload = {
            meeting_url,
            bot_name: bot_name || "WEYA by Light Eagle",
            recording_config: {
                transcript: {
                    provider: {
                        recallai_streaming: {},
                    },
                },
                realtime_endpoints: [
                    {
                        type: "webhook",
                        url: `https://${env.RAILWAY_DOMAIN}/api/webhooks/transcript`,
                        events: ["transcript.data", "transcript.partial_data"],
                    },
                ],
            },
        };
    }

    const response = await fetch(
        `https://${env.RECALL_REGION}.recall.ai/api/v1/bot/`,
        {
            method: "POST",
            headers: {
                "Authorization": `${env.RECALL_API_KEY}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify(payload),
        }
    );

    if (!response.ok) throw new Error(await response.text());

    const bot = await response.json();

    // Read active_kb_id — needed for meeting_tags write below
    const settings = await bot_settings_get();
    const active_kb_id = settings.active_kb_id;

    // Supabase'de meeting kaydı oluştur (transcript takibi için) — hem recording hem voice_agent için
    const resolvedBotName: string = (payload as any).bot_name;
    // Use ignoreDuplicates: false so that if handleTranscriptWebhook already created the row
    // (from the first transcript.data event), we still write bot_type, meeting_url, and bot_name.
    await supabase.from("meetings").upsert(
        {
            bot_id: bot.id,
            done: false,
            created_at: new Date().toISOString(),
            bot_type: botType,
            meeting_url,
            bot_name: resolvedBotName,
            user_email: args.user_email,
            meeting_start_time: new Date().toISOString(),
            ...(meetingToken ? { meeting_token: meetingToken } : {}),
        },
        { onConflict: "bot_id", ignoreDuplicates: false },
    );

    // ── Write meeting_tags so relay can filter KB by category ──────────────
    if (botType === "voice_agent" && meetingToken && active_kb_id) {
        try {
            // Look up tag_ids for the selected KB document
            const { data: tagLinks } = await supabase
                .from("kb_document_tags")
                .select("tag_id")
                .eq("document_id", active_kb_id);

            const tag_ids = (tagLinks ?? []).map((t: { tag_id: string }) => t.tag_id);

            if (tag_ids.length > 0) {
                await meeting_tags_set({
                    botId: bot.id,
                    tag_ids,
                    userEmail: args.user_email ?? "system",
                });
                console.log(`[bot_join] meeting_tags written: bot_id=${bot.id} tag_ids=${JSON.stringify(tag_ids)}`);
            } else {
                console.log(`[bot_join] no tags found for active_kb_id=${active_kb_id} — meeting_tags not written`);
            }
        } catch (tagErr) {
            // Non-fatal — bot still works, just without category filter
            console.error(`[bot_join] meeting_tags write failed (non-fatal):`, tagErr);
        }
    }

    return {
        bot_id: bot.id,
        meeting_url: bot.meeting_url,
        status: bot.status_changes?.[0]?.code ?? "created",
    };
}
