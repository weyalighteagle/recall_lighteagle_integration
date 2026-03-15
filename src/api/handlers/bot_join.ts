import { z } from "zod";
import { env } from "../config/env";
import { supabase } from "../config/supabase";

/**
 * Doğrudan meeting URL'si ile ad-hoc bot gönder.
 * Takvim event'i gerekmez — URL yeter.
 */
export async function bot_join(args: {
    meeting_url: string;
    bot_name?: string;
}) {
    const { meeting_url, bot_name } = z.object({
        meeting_url: z.string().url(),
        bot_name: z.string().optional(),
    }).parse(args);

    const response = await fetch(
        `https://${env.RECALL_REGION}.recall.ai/api/v1/bot/`,
        {
            method: "POST",
            headers: {
                "Authorization": `${env.RECALL_API_KEY}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                meeting_url,
                bot_name: bot_name || "WEYA by Light Eagle",
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
            }),
        }
    );

    if (!response.ok) throw new Error(await response.text());

    const bot = await response.json();

    // Supabase'de meeting kaydı oluştur (transcript takibi için)
    await supabase.from("meetings").insert({
        bot_id: bot.id,
        done: false,
    });

    return {
        bot_id: bot.id,
        meeting_url: bot.meeting_url,
        status: bot.status_changes?.[0]?.code ?? "created",
    };
}
