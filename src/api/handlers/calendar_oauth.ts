import { randomBytes } from "crypto";
import { z } from "zod";
import { OAuthStateSchema, type OAuthStateType } from "../../schemas/OAuthStateSchema";
import { env } from "../config/env";

/**
 * Generate an OAuth URL for the user to authorize their calendar.
 *
 * Also returns the random CSRF nonce embedded in the state. The router binds this
 * nonce to the browser by setting an httpOnly `oauth_state` cookie alongside the 302,
 * and the callback verifies the cookie matches the nonce decoded from `state` (LIG-80).
 */
export async function calendar_oauth(args: {
    platform: OAuthStateType["platform"],
}): Promise<{ oauth_url: URL, state_nonce: string }> {
    const { platform } = z.object({ platform: OAuthStateSchema.shape.platform }).parse(args);

    // Fresh, unguessable nonce per authorize request.
    const nonce = randomBytes(32).toString("base64url");
    const state = OAuthStateSchema.parse({
        platform,
        nonce,
    } satisfies OAuthStateType);

    switch (platform) {
        case "google_calendar": {
            console.log("Generating Google Calendar OAuth URL");
            const oauth_url = generate_google_calendar_oauth_url({ state });
            console.log(`Successfully generated Google Calendar OAuth URL: ${oauth_url}`);
            return { oauth_url, state_nonce: nonce };
        }
        case "microsoft_outlook": {
            console.log("Generating Outlook Calendar OAuth URL");
            const oauth_url = generate_outlook_calendar_oauth_url({ state });
            console.log(`Successfully generated Outlook Calendar OAuth URL: ${oauth_url}`);
            return { oauth_url, state_nonce: nonce };
        }
        default: {
            throw new Error("No calendar platform provided");
        }
    }
}


/**
 * Generate a Google Calendar OAuth URL for the user.
 * You can pass a custom state object to the URL to be returned in the callback.
 */
function generate_google_calendar_oauth_url(args: { state: OAuthStateType }): URL {
    const { state } = z.object({ state: OAuthStateSchema }).parse(args);
    const params = {
        client_id: env.GOOGLE_OAUTH_CLIENT_ID!,
        redirect_uri: env.GOOGLE_OAUTH_REDIRECT_URI!,
        response_type: "code",
        scope: [
            // Only read the user's calendar events.
            "https://www.googleapis.com/auth/calendar.events.readonly",
            "https://www.googleapis.com/auth/userinfo.email",
        ].join(" "),
        access_type: "offline",
        prompt: "consent select_account",
        state: Buffer.from(JSON.stringify(state)).toString("base64"),
    };

    // Build the URL with the parameters.
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.search = new URLSearchParams(params).toString();

    return url;
}

/**
 * Generate a Microsoft Outlook OAuth URL for the user.
 * You can pass a custom state object to the URL to be returned in the callback.
 */
function generate_outlook_calendar_oauth_url(args: { state: OAuthStateType }): URL {
    const { state } = z.object({ state: OAuthStateSchema }).parse(args);
    const params = {
        client_id: env.OUTLOOK_OAUTH_CLIENT_ID!,
        redirect_uri: env.OUTLOOK_OAUTH_REDIRECT_URI!,
        response_type: "code",
        scope: "offline_access openid email https://graph.microsoft.com/Calendars.Read",
        prompt: "consent select_account",
        state: Buffer.from(JSON.stringify(state)).toString("base64"),
    };

    const url = new URL("https://login.microsoftonline.com/common/oauth2/v2.0/authorize");
    url.search = new URLSearchParams(params).toString();

    return url;
}
