# Task: Tag-scoped Knowledge Base with guaranteed transcript ingestion

This is the `recall_lighteagle_integration` repo. You'll also need to touch `voice-agent-demo` (the Node + Python relay servers) for the KB search changes. Both are deployed on Railway (and Vercel for the frontend).

## Goals

1. Each document and each meeting can have multiple **tags** (e.g., `light-eagle-ai`, `inci-holding`, `investors`, `general`).
2. The voice agent in a given meeting only retrieves chunks from documents whose tags intersect with that meeting's allowed tags.
3. Every completed meeting's transcript is ingested into the KB with the meeting's tags, reliably and observably — no silent failures.
4. Add an `org_id` column to key tables as a hook for future multi-tenancy, but do NOT enforce RLS or change auth yet. This sprint is single-tenant.

## Before you start — research phase (do not code yet)

Report back on all of the following:

1. **Current `kb_categories` table**: schema, row count, how it's used in code (if at all). We may repurpose it as `kb_tags` or create a new table — decision depends on current usage.
2. **Current `meeting_kb_overrides` table**: schema, how it's populated, how it's read at agent query time.
3. **`search_knowledge_base` RPC**: current signature and all existing overloads. List every place in the codebase that calls it (Node server, Python relay, anywhere else).
4. **Bot lifecycle**: where `handleBotDone` lives, what it does, and the known issue that it doesn't complete for recording bots (bot rows with `bot_name=null`, `meeting_url=null`, created via webhook upserts rather than `bot_join()`). Confirm the current behavior by reading the code — do not trust my description if the code disagrees.
5. **KB ingestion entry points**: every code path that writes to `kb_documents` and `kb_chunks`. There's at least one for manual document upload (on the Knowledge Base page) and one for auto-transcript ingestion after `bot.done`. Confirm.
6. **Chunking config**: the 1,000-char-with-200-overlap logic — where does it live, and is it used consistently across all ingestion entry points?
7. **User settings / preferences**: is there an existing `user_settings` or equivalent table? If yes, schema. If no, we'll create one.

Do NOT start writing code until you've reported back on all 7 items and I've confirmed the direction.

## Architecture — the shape we're building

### Data model

New/changed tables:

- `orgs` (new): `id uuid PK, name text, created_at`. Seed one row for Light Eagle.
- `kb_tags` (new, or repurposed from `kb_categories`): `id uuid PK, org_id uuid, name text, slug text, color text nullable, created_by text (email), created_at`. Unique on (org_id, slug).
- `kb_document_tags` (new): join table. `document_id uuid, tag_id uuid, PRIMARY KEY (document_id, tag_id)`.
- `meeting_tags` (new): join table. `bot_id text, tag_id uuid, PRIMARY KEY (bot_id, tag_id)`.
- `kb_ingestion_log` (new): `id uuid PK, bot_id text, status text CHECK (status IN ('pending','success','failed','skipped')), chunk_count int, error text, note text, created_at, updated_at`.
- `user_settings` (new, unless one exists): `user_email text PK, default_tag_ids uuid[], org_id uuid, created_at, updated_at`.

Additions to existing tables (all nullable, no backfill required beyond the Light Eagle seed):

- `kb_documents`: add `org_id uuid nullable`.
- `kb_chunks`: add `org_id uuid nullable`. Populated at chunk creation by copying from parent document.
- `meetings`: add `org_id uuid nullable`.
- `kb_categories` → decided in research phase to keep alongside `kb_tags`. Deprecation is later cleanup.

**Do not enforce RLS in this sprint.** `org_id` is a forward-looking column. Queries may optionally filter by it, but we're not adding row-level security policies or changing auth.

### Tag resolution at agent query time

A meeting's allowed tags are computed as:

1. If `meeting_tags` has rows for this `bot_id` → use those.
2. Else if the meeting's user has `user_settings.default_tag_ids` set → use those.
3. Else → no filter (all tags allowed). This is the safe fallback, not a failure.

The Node and Python relay servers both need this lookup. Extract into a shared helper (`getAllowedTagsForMeeting(botId, userEmail)`) so the logic lives in one place.

### KB search RPC — new signature

```sql
search_knowledge_base(
  query_embedding vector,
  p_org_id uuid DEFAULT NULL,
  p_allowed_tag_ids uuid[] DEFAULT NULL,
  p_match_threshold float DEFAULT 0.7,
  p_match_count int DEFAULT 5
)
```

Filter logic:

- `p_org_id IS NULL OR kd.org_id = p_org_id`
- `p_allowed_tag_ids IS NULL OR EXISTS (SELECT 1 FROM kb_document_tags kdt WHERE kdt.document_id = kd.id AND kdt.tag_id = ANY(p_allowed_tag_ids))`

Both are optional filters using the pattern already established in this codebase. The existing `meeting_type` filter can stay for now — don't rip it out, just add the new tag filter alongside.

**CRITICAL: Follow the overload trap pattern from memory.** Before `CREATE OR REPLACE FUNCTION`, `DROP FUNCTION IF EXISTS` for every existing overload of `search_knowledge_base`. Do not create a new overload; replace the signature. Add `CREATE EXTENSION IF NOT EXISTS vector;` at the top of the migration.

### Transcript ingestion — guaranteed + observable

Every `bot.done` webhook must produce a `kb_ingestion_log` row and a corresponding document + chunks. The flow:

1. `bot.done` received.
2. Insert `kb_ingestion_log` row with `status='pending'`, `bot_id=<botId>`.
3. Resolve the meeting's tags (using the rules above at ingest time, so the document is tagged the moment it's created).
4. Fetch transcript from Recall.ai.
5. Create `kb_documents` row with the meeting title + `org_id` + transcript content.
6. Link document to tags via `kb_document_tags`.
7. Chunk the transcript (use the existing 1000/200 logic). Create `kb_chunks` rows with `org_id` copied from the document.
8. Generate embeddings for all chunks (title-prefixed, per existing pattern).
9. Update the log row: `status='success'`, `chunk_count=<n>`.

If ANY step from 4 onward throws, catch it, update the log row to `status='failed'` with the error message, and return. Do not leave the log row in `pending` state.

**Known failure case to handle**: recording bots (created via `transcript_webhook` upserts) have `bot_name=null` and `meeting_url=null`. Check the current `handleBotDone` logic — if it short-circuits for these rows, that's the bug causing missed ingestions. Either fix the short-circuit or route these through a separate code path, but they must end up in `kb_ingestion_log` and `kb_documents` like any other meeting.

Duplicate protection: if a `kb_documents` row already exists for this `bot_id`, don't create a second one. Update the ingestion log to `success` with a note, exit cleanly. (Webhooks retry; we must be idempotent.)

### Frontend changes

**`/dashboard/knowledge-base` page:**

- Section for managing tags: create, rename, delete, pick color. Deleting a tag that's in use requires confirmation and just removes the links (doesn't delete documents).
- Each document row shows its tags as colored pills. Clicking a pill removes it. A "+" adds one from a dropdown.
- No chunk-level UI. Chunks inherit their document's tags and don't appear in the UI at all.

**`/dashboard/notes` page:**

- Each meeting row shows an ingestion status indicator (green / yellow pending / red failed with retry button).
- Each meeting row shows its tags (same pill pattern). Editable inline, same as the title rename pattern already shipped.
- Clicking retry on a failed ingestion re-runs the ingestion flow for that `bot_id`.

**New `/dashboard/settings` section (or wherever existing user settings live):**

- "Default tags for new meetings": multi-select of tags. Saved to `user_settings.default_tag_ids`.

### Voice agent relays

Both `node-server/lib/knowledge-base.js` and the Python relay in `voice-agent-demo`:

- Before calling `search_knowledge_base`, call `getAllowedTagsForMeeting(botId, userEmail)` to resolve the tag set.
- Pass `p_allowed_tag_ids` to the RPC.
- Keep the existing `KB_ENABLED` toggle, `KB_MATCH_THRESHOLD`, `KB_MATCH_COUNT` env vars — don't touch those.

Changes must be mirrored in both servers. Per memory, syncing the Python relay with Node changes is a known pending item — do both in the same PR to keep them in sync.

## Phased implementation

Ship each phase as its own commit so it can be reviewed and tested before the next one. If you have questions at a phase boundary, stop and ask.

### Phase 1 — Data model foundation (no behavior changes)

- Migration: create `orgs`, `kb_tags`, `kb_document_tags`, `meeting_tags`, `kb_ingestion_log`, `user_settings`. Seed one `orgs` row for Light Eagle.
- Migration: add nullable `org_id` to `kb_documents`, `kb_chunks`, `meetings`. Backfill with the Light Eagle org id.
- Verify with `SELECT` queries that all existing rows have `org_id` set and nothing else broke.
- No code changes yet. Ship and verify the migration.

### Phase 2 — Tag management UI + backend

- CRUD endpoints for tags. Assign/unassign tags on documents.
- Knowledge Base page UI for tags (create/rename/delete/color) and document tagging (pills).
- Manual document upload on KB page: tag-picker in the upload dialog.
- No agent-side filtering yet. KB search still returns all documents regardless of tags.

Phase 2 ships a functional tag management system even though it doesn't affect the agent yet. This is intentional — we want to populate the data before we start filtering on it.

### Phase 3 — Ingestion reliability + observability

- `kb_ingestion_log` writes from `handleBotDone` (and whichever other path is relevant based on your research).
- Fix the recording-bot short-circuit so those meetings actually produce log rows and documents.
- Notes page UI: ingestion status indicator per meeting, retry button on failed rows.
- Retry endpoint: re-runs ingestion for a given `bot_id`, idempotent.

Phase 3 surfaces the ingestion problem before we rely on it for agent filtering. If ingestion is broken for recording bots, we want to know at Phase 3 and fix it, not discover it in Phase 5 when the agent is returning empty results.

### Phase 4 — Tag resolution at ingest time + per-meeting tags

- When ingestion creates a document, look up the meeting's tags (meeting_tags → user default → empty) and link them via `kb_document_tags`.
- Notes page: per-meeting tag editing UI (same pill pattern).
- User settings page: default tags multi-select.
- Existing documents (backfilled with no tags) stay untagged. We can mass-tag from the UI.

### Phase 5 — Agent-side tag filtering

- New `search_knowledge_base` RPC with the signature above. Drop old overloads explicitly.
- `getAllowedTagsForMeeting` helper in both Node and Python relays.
- Pass resolved tag IDs to every RPC call.
- Keep unfiltered fallback: if no meeting context is available, pass `NULL` for `p_allowed_tag_ids` (not an empty array — an empty array would return zero results).

### Phase 6 — Test the end-to-end flow

- Create two tags: `test-alpha`, `test-beta`.
- Upload one document tagged `test-alpha`, one tagged `test-beta`.
- Create a meeting, tag it `test-alpha` only.
- Run a KB search through the voice agent for that meeting — assert only the `test-alpha` document's chunks appear.
- Create another meeting with no tags, user default also empty — assert both documents appear (unfiltered fallback works).
- Document this test in a terminal script (`test-tag-filtering.js` or similar) in the same style as the existing `test-kb-search.js` test scripts.

## Hard constraints

- Every migration must `DROP FUNCTION IF EXISTS` for all prior overloads before `CREATE OR REPLACE FUNCTION`. If you skip this, the 42P13 error will bite you.
- `CREATE EXTENSION IF NOT EXISTS vector;` at the top of any migration referencing the `vector` type.
- Optional filter pattern throughout: `p_param IS NULL OR <condition>`. Never require a non-null filter in a way that can zero out results.
- Empty arrays are not null. `p_allowed_tag_ids = '{}'` will return zero results. The fallback must pass NULL, not `[]`.
- Don't expose chunk-level data in the user-facing UI. Chunks are an implementation detail.
- Don't enforce org_id yet. Column exists, queries may filter by it, but nothing breaks if it's NULL.
- Test scripts and migration files are excluded from production pushes, per existing repo convention.
- Confirm you're on the `weya-recallai` Supabase project before running any migration. Not `weya-chat-history`. Verify with a `SELECT current_database(), current_user;` before the ALTER.

## What NOT to do

- Do NOT add RLS policies. Out of scope.
- Do NOT add auth changes. Existing `requireAuth` + `userEmail` pattern stays.
- Do NOT add LLM-based auto-tagging. Tags are user-picked for now.
- Do NOT rip out the existing `meeting_type` filter. Leave it alone; we can deprecate later.
- Do NOT add hierarchical tags / tag nesting. Flat list only.
- Do NOT touch the existing chunk size / overlap / embedding logic. It works; leave it.
- Do NOT build bulk-tagging UI in this sprint. Single-document tagging is enough.
- Do NOT re-embed existing chunks. Tags attach at the document level, no embedding change needed.

## Deliverables per phase

- One branch per phase, or one branch with one commit per phase — your call, but each phase must be independently reviewable.
- Each PR description lists: migration run command, affected files, any deviation from this prompt (with reasoning), and a manual verification checklist the reviewer can run.
- TypeScript clean (`npm run typecheck` or equivalent) before each push. No conflict-resolution round-trips like last time.
- Smoke test after each phase on the Vercel preview deploy before merging.

## Questions you should ask me if you encounter them

- If `kb_categories` has production data in use, do we migrate it or leave it alongside `kb_tags`?
- If `handleBotDone` turns out to be structurally broken in a way that needs a bigger refactor, flag it before rewriting.
- If the Python relay is significantly behind the Node server and syncing it is a multi-day job on its own, flag it and we'll split it off.
- Any time the current code disagrees with this prompt's description — stop and ask. The prompt is what we want; the code is what we have; bridging them is the work.
