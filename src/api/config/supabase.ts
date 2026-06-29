import { createClient } from "@supabase/supabase-js";
import { env } from "./env";

// SADECE gerçek admin operasyonlarında kullan:
// - Webhook'tan gelen system-level yazma işlemleri
// - Cron job'lar
// - Migration scriptleri
export const supabaseAdmin = createClient(
    env.SUPABASE_URL,
    env.SUPABASE_SERVICE_KEY,
    { auth: { persistSession: false } }
);

// Kullanıcı işlemlerinde her zaman bunu kullan — RLS aktif:
export function supabaseForUser(userJwt: string) {
    return createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
        global: {
            headers: { Authorization: `Bearer ${userJwt}` }
        },
        auth: { persistSession: false }
    });
}
