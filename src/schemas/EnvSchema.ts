import { z } from "zod";

export const EnvSchema = z.object({
    PORT: z.coerce.number().default(4000),
    RECALL_REGION: z.string(),
    RAILWAY_DOMAIN: z.string(),
    RECALL_API_KEY: z.string(),

    // Recall webhook signature verification (LIG-81).
    // All optional so a missing secret never crashes boot — monitor mode handles it.
    // Workspace Verification Secret from Recall (Svix-style, starts with whsec_).
    RECALL_WEBHOOK_SECRET: z.string().optional(),
    // Reserved for the legacy Recall dashboard webhook endpoint; may be unset.
    RECALL_SVIX_WEBHOOK_SECRET: z.string().optional(),
    // Monitor mode by default. Only the literal "true" enables enforcement;
    // anything else (including "false" and unset) stays in monitor mode.
    RECALL_WEBHOOK_ENFORCE: z
        .string()
        .optional()
        .transform((v) => v === "true"),

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
    OPENAI_API_KEY: z.string().optional(),

    // Clerk Auth
    CLERK_PUBLISHABLE_KEY: z.string(),
    CLERK_SECRET_KEY: z.string(),

    // Anthropic
    ANTHROPIC_API_KEY: z.string().min(1),
});
