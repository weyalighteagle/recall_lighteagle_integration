import { z } from "zod";

export const EnvSchema = z.object({
    PORT: z.coerce.number().default(4000),
    RECALL_REGION: z.string(),
    RAILWAY_DOMAIN: z.string(),
    RECALL_API_KEY: z.string(),

    GOOGLE_OAUTH_CLIENT_ID: z.string().optional(),
    GOOGLE_OAUTH_CLIENT_SECRET: z.string().optional(),
    GOOGLE_OAUTH_REDIRECT_URI: z.string().optional(),

    OUTLOOK_OAUTH_CLIENT_ID: z.string().optional(),
    OUTLOOK_OAUTH_CLIENT_SECRET: z.string().optional(),
    OUTLOOK_OAUTH_REDIRECT_URI: z.string().optional(),

    SUPABASE_URL: z.string(),
    SUPABASE_SERVICE_KEY: z.string(),

    // Voice Agent configuration
    VOICE_AGENT_PAGE_URL: z.string().optional(),
    VOICE_AGENT_WSS_URL: z.string().optional(),
});
