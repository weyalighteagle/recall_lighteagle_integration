/**
 * Backfill script: populate meetings.user_email from Recall.ai calendar data.
 *
 * For every calendar registered in Recall.ai, this script:
 *   1. Pages through all calendar events going back 365 days
 *   2. Collects every bot_id that was scheduled for that calendar
 *   3. Updates meetings.user_email = platform_email for each matching row
 *      (skips rows that already have user_email set)
 *
 * Run with:
 *   npx tsx scripts/backfill_user_email.ts
 *
 * Reads credentials from .env at the project root (RECALL_API_KEY, RECALL_REGION,
 * SUPABASE_URL, SUPABASE_SERVICE_KEY).
 */

import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { createClient } from "@supabase/supabase-js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

// ── env ──────────────────────────────────────────────────────────────────────
const RECALL_API_KEY = process.env.RECALL_API_KEY!;
const RECALL_REGION = process.env.RECALL_REGION ?? "eu-central-1";
const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY!;

if (!RECALL_API_KEY) throw new Error("RECALL_API_KEY is not set");
if (!SUPABASE_URL) throw new Error("SUPABASE_URL is not set");
if (!SUPABASE_SERVICE_KEY) throw new Error("SUPABASE_SERVICE_KEY is not set");

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
const BASE_URL = `https://${RECALL_REGION}.recall.ai/api/v2`;
const HEADERS = { Authorization: RECALL_API_KEY, "Content-Type": "application/json" };

// ── helpers ───────────────────────────────────────────────────────────────────

/** Fetch all pages of a paginated Recall.ai list endpoint. */
async function fetchAllPages<T>(firstUrl: string): Promise<T[]> {
    const results: T[] = [];
    let url: string | null = firstUrl;
    while (url) {
        const res = await fetch(url, { headers: HEADERS });
        if (!res.ok) throw new Error(`Recall API error: ${res.status} ${await res.text()}`);
        const data = await res.json();
        results.push(...(data.results as T[]));
        url = data.next ?? null;
    }
    return results;
}

interface RecallCalendar {
    id: string;
    platform_email: string | null;
}

interface RecallCalendarEvent {
    bots: { bot_id: string }[];
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
    console.log("=== Backfill meetings.user_email ===\n");

    // 1. Fetch all calendars registered in Recall.ai
    console.log("Fetching all calendars from Recall.ai...");
    const calendars = await fetchAllPages<RecallCalendar>(
        `${BASE_URL}/calendars`,
    );
    console.log(`  Found ${calendars.length} calendar(s)\n`);

    const oneYearAgo = new Date();
    oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
    const startTimeGte = oneYearAgo.toISOString();

    // bot_id → platform_email (first owner wins if a bot appears in multiple calendars)
    const botOwner = new Map<string, string>();
    // platform_email → Set<bot_id> collected for that user
    const userBots = new Map<string, Set<string>>();

    // 2. For each calendar, fetch all events and collect bot_ids
    for (const calendar of calendars) {
        const email = calendar.platform_email;
        if (!email) {
            console.log(`  Skipping calendar ${calendar.id} — no platform_email`);
            continue;
        }

        const eventsUrl =
            `${BASE_URL}/calendar-events?calendar_id=${encodeURIComponent(calendar.id)}` +
            `&start_time__gte=${encodeURIComponent(startTimeGte)}`;

        let events: RecallCalendarEvent[];
        try {
            events = await fetchAllPages<RecallCalendarEvent>(eventsUrl);
        } catch (err) {
            console.warn(`  Warning: failed to fetch events for calendar ${calendar.id} (${email}): ${err}`);
            continue;
        }

        for (const event of events) {
            for (const bot of event.bots ?? []) {
                if (!botOwner.has(bot.bot_id)) {
                    botOwner.set(bot.bot_id, email);
                }
                if (!userBots.has(email)) userBots.set(email, new Set());
                userBots.get(email)!.add(bot.bot_id);
            }
        }
    }

    const totalBotsMapped = botOwner.size;
    console.log(`Mapped ${totalBotsMapped} bot_id(s) across ${userBots.size} unique platform_email(s)\n`);
    if (totalBotsMapped === 0) {
        console.log("Nothing to backfill. Exiting.");
        return;
    }

    // 3. Fetch all meeting rows that still have user_email = NULL
    console.log("Fetching meetings with user_email = NULL from Supabase...");
    const { data: nullRows, error: fetchErr } = await supabase
        .from("meetings")
        .select("bot_id")
        .is("user_email", null);

    if (fetchErr) throw new Error(`Supabase fetch error: ${fetchErr.message}`);
    const nullBotIds = new Set((nullRows ?? []).map((r: { bot_id: string }) => r.bot_id));
    console.log(`  Found ${nullBotIds.size} meeting row(s) with user_email = NULL\n`);

    // 4. For each user, update their bot rows (only where user_email IS NULL)
    const statsPerUser: { email: string; updated: number; alreadySet: number; notInDb: number }[] = [];
    const unmatchedBotIds: string[] = [];

    for (const [email, botIds] of userBots) {
        let updated = 0;
        let alreadySet = 0;
        let notInDb = 0;

        const toUpdate: string[] = [];
        for (const botId of botIds) {
            if (nullBotIds.has(botId)) {
                toUpdate.push(botId);
            } else {
                // Either already has user_email or doesn't exist in DB
                alreadySet++;
            }
        }

        if (toUpdate.length > 0) {
            // Batch update in chunks of 100 to stay within PostgREST limits
            const CHUNK = 100;
            for (let i = 0; i < toUpdate.length; i += CHUNK) {
                const chunk = toUpdate.slice(i, i + CHUNK);
                const { error: updateErr } = await supabase
                    .from("meetings")
                    .update({ user_email: email })
                    .in("bot_id", chunk)
                    .is("user_email", null);

                if (updateErr) {
                    console.error(`  Error updating chunk for ${email}: ${updateErr.message}`);
                } else {
                    updated += chunk.length;
                }
            }
        }

        statsPerUser.push({ email, updated, alreadySet, notInDb });
    }

    // 5. Find bot_ids from Recall that have no meeting row at all
    for (const botId of botOwner.keys()) {
        if (!nullBotIds.has(botId)) {
            // Check if it exists in DB with user_email already set — handled in alreadySet above
            // Here we catch bot_ids that aren't in the DB at all
        }
    }

    // Identify bot_ids that appear in Recall events but have NO row in meetings table
    const allDbBotIds = new Set<string>();
    const { data: allDbRows } = await supabase.from("meetings").select("bot_id");
    for (const r of allDbRows ?? []) allDbBotIds.add((r as { bot_id: string }).bot_id);

    for (const botId of botOwner.keys()) {
        if (!allDbBotIds.has(botId)) {
            unmatchedBotIds.push(botId);
        }
    }

    // 6. Print report
    console.log("=== Results ===\n");
    let totalUpdated = 0;
    for (const s of statsPerUser) {
        console.log(`  ${s.email}`);
        console.log(`    updated:     ${s.updated} row(s)`);
        console.log(`    already set: ${s.alreadySet} row(s)`);
        totalUpdated += s.updated;
    }

    console.log(`\nTotal rows updated: ${totalUpdated}`);

    if (unmatchedBotIds.length > 0) {
        console.log(`\nBot IDs found in Recall calendar events but NOT in meetings table (${unmatchedBotIds.length}):`);
        for (const id of unmatchedBotIds) {
            console.log(`  ${id}  (owner: ${botOwner.get(id)})`);
        }
    } else {
        console.log("\nAll Recall-mapped bot IDs exist in the meetings table.");
    }

    console.log("\nDone.");
}

main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
});
