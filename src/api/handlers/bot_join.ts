import { z } from "zod";
import { env } from "../config/env";
import { supabase } from "../config/supabase";

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

    if (botType === "voice_agent") {
        const output_media_url = `${env.VOICE_AGENT_PAGE_URL}?wss=${encodeURIComponent(env.VOICE_AGENT_WSS_URL!)}`;

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
                        assembly_ai_async: {
                            language_code: "tr",
                            speaker_labels: true,
                            speakers_expected: 3,
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
                        assembly_ai_async: {
                            language_code: "tr",
                            speaker_labels: true,
                            speakers_expected: 3,
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
        },
        { onConflict: "bot_id", ignoreDuplicates: false },
    );

    return {
        bot_id: bot.id,
        meeting_url: bot.meeting_url,
        status: bot.status_changes?.[0]?.code ?? "created",
    };
}
