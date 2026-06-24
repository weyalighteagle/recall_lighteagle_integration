import { z } from "zod";

/**
 * Schema for the OAuth state object.
 * This is passed from the OAuth calendar url to the oauth callback webhook.
 */
export const OAuthStateSchema = z.object({
    platform: z.enum(["google_calendar", "microsoft_outlook"]),
    // Random CSRF nonce, bound to the browser via an httpOnly cookie and verified on callback (LIG-80).
    nonce: z.string(),
});

export type OAuthStateType = z.infer<typeof OAuthStateSchema>;