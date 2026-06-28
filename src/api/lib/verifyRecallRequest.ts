import { createHmac, timingSafeEqual } from "crypto";

/**
 * Recall webhook signature verification (LIG-81).
 *
 * Recall signs webhooks (and websocket Upgrade requests) using the Svix scheme:
 *   - Headers: webhook-id / webhook-timestamp / webhook-signature
 *     (legacy fallback: svix-id / svix-timestamp / svix-signature)
 *   - Signed content: `${webhook-id}.${webhook-timestamp}.${rawBody}` — the EXACT
 *     raw request bytes, NOT a re-serialized JSON object.
 *   - Secret format: `whsec_<base64>`. The HMAC-SHA256 key is the base64-decode of
 *     the part after `whsec_`. The signature is base64.
 *   - webhook-signature is a space-delimited list of `v1,<sig>` entries.
 *
 * This is a pure function: it NEVER throws and performs no I/O. The caller decides
 * whether to log, monitor, or reject based on the returned result.
 */

export type RecallVerifyReason = "pass" | "invalid" | "missing_headers" | "no_secret";

export interface RecallVerifyResult {
    ok: boolean;
    reason: RecallVerifyReason;
    /** Name of the secret that matched (for logs), or null when none matched. */
    matched: string | null;
}

export interface RecallSecret {
    name: string;
    value: string;
}

/** Node lowercases header names; values may be a string or string[]. Take the first. */
function firstHeader(header: string | string[] | undefined): string | undefined {
    return Array.isArray(header) ? header[0] : header;
}

export function verifyRecallRequest(args: {
    /** EXACT request bytes as received, captured BEFORE JSON.parse. */
    rawBody: string;
    headers: Record<string, string | string[] | undefined>;
    /** Try each secret; pass if ANY matches. */
    secrets: RecallSecret[];
}): RecallVerifyResult {
    const { rawBody, headers, secrets } = args;

    // No usable secret configured at all → cannot verify. Caller decides fail-open.
    const usableSecrets = (secrets ?? []).filter(
        (s) => s && typeof s.value === "string" && s.value.trim() !== "",
    );
    if (usableSecrets.length === 0) {
        return { ok: false, reason: "no_secret", matched: null };
    }

    const id = firstHeader(headers["webhook-id"]) ?? firstHeader(headers["svix-id"]);
    const ts =
        firstHeader(headers["webhook-timestamp"]) ?? firstHeader(headers["svix-timestamp"]);
    const sigHeader =
        firstHeader(headers["webhook-signature"]) ?? firstHeader(headers["svix-signature"]);

    if (!id || !ts || !sigHeader) {
        return { ok: false, reason: "missing_headers", matched: null };
    }

    const toSign = `${id}.${ts}.${rawBody}`;

    for (const secret of usableSecrets) {
        // Only whsec_-prefixed secrets are valid Svix signing keys.
        if (!secret.value.startsWith("whsec_")) continue;

        const key = Buffer.from(secret.value.slice("whsec_".length), "base64");
        const expected = createHmac("sha256", key).update(toSign).digest("base64");
        const expectedBuf = Buffer.from(expected, "base64");

        // webhook-signature is a space-delimited list of `v1,<sig>` entries.
        for (const entry of sigHeader.split(" ")) {
            if (!entry) continue;
            const commaIdx = entry.indexOf(",");
            if (commaIdx === -1) continue;
            const version = entry.slice(0, commaIdx);
            const sig = entry.slice(commaIdx + 1);
            if (version !== "v1") continue;

            const sigBuf = Buffer.from(sig, "base64");
            // timingSafeEqual throws on length mismatch — guard with an explicit length check.
            if (sigBuf.length !== expectedBuf.length) continue;
            if (timingSafeEqual(sigBuf, expectedBuf)) {
                return { ok: true, reason: "pass", matched: secret.name };
            }
        }
    }

    return { ok: false, reason: "invalid", matched: null };
}
