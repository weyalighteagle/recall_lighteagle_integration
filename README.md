# Light Eagle × Recall.ai Integration

A full-stack meeting-intelligence platform built on [Recall.ai's Calendar V2 API](https://docs.recall.ai/docs/calendar-v2-integration-guide).
It connects a user's calendar, automatically sends recording or voice-agent bots to
their meetings, captures transcripts, and turns them into a searchable, tag- and
project-scoped knowledge base.

> The npm package is named `calendar_v2` for historical reasons — it has since grown
> well beyond the original calendar demo.

## Features

-   **Calendar integration** — connect Google Calendar or Microsoft Outlook via OAuth
-   **Auto-join & manual scheduling** — bots join every upcoming meeting automatically, or you toggle them per event
-   **Two bot types** — a **recording** bot (transcription) and a **voice agent** bot (interactive, OpenAI Realtime relay)
-   **Transcripts & notes** — transcripts are captured via webhook, cleaned, and shown in the dashboard
-   **Knowledge base** — transcripts and documents are chunked, embedded, and made semantically searchable
-   **Tags & categories** — scope what each meeting's voice agent can see by tagging meetings and documents
-   **Projects & sharing** — group meetings/documents into projects, invite teammates, and manage `admin` / `member` roles
-   **Auth** — Clerk-backed sign-in; every dashboard API route is JWT-protected

## Tech stack

| Layer | Technology |
|---|---|
| Frontend | React 18 + Vite SPA, React Router, TanStack Query, Tailwind v4, Radix UI |
| Backend | Node `http` server (TypeScript, run with `tsx`) |
| Auth | [Clerk](https://clerk.com) |
| Database & storage | [Supabase](https://supabase.com) (Postgres + `pgvector` RPC search + Storage) |
| Embeddings | Anthropic |
| Meeting infra | [Recall.ai](https://recall.ai) Calendar V2 + bots |
| Hosting | [Railway](https://railway.app) — `staging` and `production` environments |

## Architecture & Request Flows

### 1. Connecting a Calendar

When a user clicks "Connect Google" or "Connect Outlook":

```
  Client              Server          Calendar Provider        Recall.ai
    │                   │             (Google/Outlook)              │
    │                   │                      │                    │
    │ GET /api/calendar/oauth?platform=google_calendar|microsoft_outlook
    │──────────────────▶│                      │                    │
    │                   │                      │                    │
    │                   │ 302 Redirect to provider OAuth            │
    │                   │─────────────────────▶│                    │
    │                   │                      │                    │
    │                   │        User authorizes calendar access    │
    │                   │                      │                    │
    │   Redirect back with auth code           │                    │
    │◀─────────────────────────────────────────│                    │
    │                   │                      │                    │
    │ GET /api/calendar/oauth/callback?code=abc123                  │
    │──────────────────▶│                      │                    │
    │                   │                      │                    │
    │                   │  Exchange code for   │                    │
    │                   │  OAuth tokens        │                    │
    │                   │─────────────────────▶│                    │
    │                   │  { access_token,     │                    │
    │                   │    refresh_token }   │                    │
    │                   │◀─────────────────────│                    │
    │                   │                      │                    │
    │                   │   POST https://REGION.recall.ai/api/v2/calendars
    │                   │   { refresh_token, client_id, ... }       │
    │                   │─────────────────────────────────────────-▶│
    │                   │                      │   Calendar created │
    │                   │◀─────────────────────────────────────────-│
    │                   │                      │                    │
    │   302 Redirect to /dashboard/calendar    │                    │
    │◀──────────────────│                      │                    │
```

### 2. Calendar Sync & Auto-Scheduling (via Webhooks)

After OAuth (and on ongoing calendar changes), calendar providers notify Recall.ai via webhooks, which then notifies your server:

```
  Google/Outlook          Recall.ai                 Server
       │                      │                       │
       │  Calendar event      │                       │
       │  created/updated     │                       │
       │  (webhook push)      │                       │
       │─────────────────────▶│                       │
       │                      │         POST /api/recall/webhook
       │                      │         { event: "calendar.sync_events",
       │                      │           calendar_id, last_updated_ts }
       │                      │──────────────────────▶│
       │                      │                       │
       │                      │ GET https://REGION.recall.ai/api/v2/calendar-events
       │                      │          ?calendar_id=...&updated_at__gte={last_updated_ts}
       │                      │◀──────────────────────│
       │                      │                       │
       │                      │ [only changed events] │
       │                      │──────────────────────▶│
       │                      │                       │
       │                      │       For each event with meeting_url
       │                      │       and start_time in future (if auto-join is on):
       │                      │                       │
       │                      │  POST https://REGION.recall.ai/api/v2/calendar-events/{id}/bot
       │                      │◀──────────────────────│
       │                      │   { bot scheduled }   │
       │                      │──────────────────────▶│
       │                      │         200 OK        │
       │                      │◀──────────────────────│
```

### 3. Transcript Ingestion (after a meeting)

Once a recording bot finishes, Recall.ai posts the transcript back, which is cleaned, stored, chunked, embedded, and indexed into the knowledge base:

```
  Recall.ai                     Server                         Supabase
     │                            │                               │
     │  POST /api/webhooks/transcript                             │
     │───────────────────────────▶│                               │
     │                            │  clean + store transcript     │
     │                            │──────────────────────────────▶│
     │                            │  chunk → embed → upsert vectors│
     │                            │──────────────────────────────▶│
     │                            │       200 OK                  │
     │◀───────────────────────────│                               │
```

### Key Points

-   **Push-based sync** — providers send webhooks to Recall, which notifies your server via `calendar.update` / `calendar.sync_events`. Use `last_updated_ts` to fetch only changed events.
-   **Auto-join toggle** — a workspace-level `bot-settings` flag controls whether bots are scheduled automatically; turning it on triggers a catch-up scan over upcoming events.
-   **Deduplication keys** — recording bots use a `rec-` prefix and voice-agent bots a `va-` prefix, so the two never collide and duplicate bots are prevented across users on the same meeting.
-   **Recall auto-manages bots** — automatically unschedules bots when events are deleted or calendars disconnected, and reschedules when meeting times change.

## Deployment & Configuration

The app runs entirely on **Railway**, with two environments:

| Environment | Branch | Purpose |
|---|---|---|
| `production` | `main` | Live, stable deployment |
| `staging` | `develop` | Integration / pre-production testing |

> **There are no `.env` files.** All configuration and secrets live in Railway's
> environment variables, scoped per environment. Set, edit, and read them in the
> Railway dashboard — never commit secrets to the repo. When you add a new variable,
> add it to **both** the `staging` and `production` services and to the
> `EnvSchema` (`src/schemas/EnvSchema.ts`) so startup validation stays in sync.

### Environment variables

Validated on boot by [`src/schemas/EnvSchema.ts`](src/schemas/EnvSchema.ts) (via `src/api/config/env.ts`):

| Variable | Required | Purpose |
|---|---|---|
| `PORT` | – | Server port (defaults to `4000`) |
| `RAILWAY_DOMAIN` | ✅ | Public backend domain (no protocol) — used to build OAuth redirect/log URLs |
| `RECALL_API_KEY` | ✅ | Recall.ai API key |
| `RECALL_REGION` | ✅ | Recall region, e.g. `eu-central-1`, `us-west-2` |
| `SUPABASE_URL` | ✅ | Supabase project URL |
| `SUPABASE_SERVICE_KEY` | ✅ | Supabase service-role key (backend only) |
| `CLERK_PUBLISHABLE_KEY` | ✅ | Clerk publishable key (`pk_…`) — backend |
| `CLERK_SECRET_KEY` | ✅ | Clerk secret key (`sk_…`) — verifies JWTs |
| `VITE_CLERK_PUBLISHABLE_KEY` | ✅ | Clerk publishable key exposed to the Vite frontend |
| `ANTHROPIC_API_KEY` | ✅ | Embeddings for knowledge-base search |
| `GOOGLE_OAUTH_CLIENT_ID` / `_SECRET` / `_REDIRECT_URI` | one provider | Google Calendar OAuth credentials |
| `OUTLOOK_OAUTH_CLIENT_ID` / `_SECRET` / `_REDIRECT_URI` | one provider | Outlook Calendar OAuth credentials |
| `VOICE_AGENT_PAGE_URL` | voice agent | Output-media page shown on the bot's camera |
| `VOICE_AGENT_WSS_URL` | voice agent | OpenAI Realtime relay WebSocket URL |
| `OPENAI_API_KEY` | voice agent | OpenAI key for the voice agent relay |

At least one calendar provider (Google **or** Outlook) must be fully configured, and
each provider's redirect URI must end in `/api/calendar/oauth/callback`.

## Local development

There are no `.env` files — pull configuration from Railway at run time so you're
always running against real **staging** values.

```bash
# 1. Install dependencies
npm install

# 2. Authenticate and link this repo to the Railway project (once)
railway login
railway link        # select the project, then the `staging` environment

# 3. Run the dev servers with Railway-injected staging env vars
railway run npm run dev
```

`npm run dev` starts both processes concurrently:

-   **Backend**: http://localhost:4000 (`tsx watch src/api/index.ts`)
-   **Frontend**: http://localhost:5173 (Vite)

For webhooks to reach your machine during local work, expose port `4000` (e.g. with a
tunnel) and point the Recall.ai webhook + OAuth redirect URIs at that public URL.

### Other scripts

```bash
npm run build      # Vite production build → dist/client
npm start          # Run the compiled backend (node dist/api/index.js)
npx tsc --noEmit   # Type-check (also run in CI)
```

## Project Structure

```
.
├── src/
│   ├── api/                         # Backend — Node http server
│   │   ├── index.ts                 # Single HTTP server: routing for every endpoint
│   │   ├── config/
│   │   │   ├── env.ts               # Loads + validates env vars on boot
│   │   │   └── supabase.ts          # Shared Supabase client (a core "god node")
│   │   ├── middleware/auth.ts       # requireAuth — Clerk JWT verification
│   │   ├── helpers/
│   │   │   ├── projectAccess.ts     # assertProjectAccess — role/membership guard
│   │   │   └── sharingFilter.ts     # KB sharing/isolation filters
│   │   ├── lib/cleanTranscript.ts   # Transcript normalization
│   │   ├── fetch_with_retry.ts      # Recall.ai HTTP helper with retry
│   │   └── handlers/                # One module per feature area (see table below)
│   ├── client/                      # Frontend — React SPA
│   │   ├── Main.tsx                 # Entry: Clerk + Router + React Query providers
│   │   ├── App.tsx                  # Calendar view (connect, events, bot toggles)
│   │   ├── pages/                   # Routed pages (Notes, KB, Voice Agent, Settings, Invite…)
│   │   ├── components/
│   │   │   ├── modules/             # DashboardWrapper (sidebar shell)
│   │   │   └── ui/                  # Radix-based UI kit (Button, Card, Sidebar, …)
│   │   ├── hooks/                   # React Query hooks (calendars, events, toggle recording)
│   │   ├── lib/ · utils/            # parseApiError, cn() class-name helper
│   │   └── index.html · index.css
│   └── schemas/                     # Zod schemas (Env, Calendar/Event artifacts, webhooks)
├── supabase/
│   └── migrations/                  # SQL migrations (+ rollbacks/)
├── scripts/                         # One-off backfills & data migrations (LIG-17, meeting-type, …)
├── docs/sprints/                    # Design notes
├── graphify-out/                    # Local code-graph output (gitignored — see CONTRIBUTING)
├── middleware.ts                    # Edge middleware
├── vercel.json · vite.config.ts · tsconfig.json
└── package.json
```

> Structure derived from the codebase graph (`graphify`). Its most-connected
> "god nodes" — `cn()` (UI class-name helper), `supabase` (data access),
> `assertProjectAccess()` (authorization), `env` (config), and `recall_webhook()`
> (the calendar sync + scheduling core) — are the abstractions most other modules
> depend on, and a good place to start reading. See
> [Knowledge graph (graphify)](CONTRIBUTING.md#knowledge-graph-graphify) for how to
> build and query it.

### `src/api/handlers/` — feature modules

| File | Purpose |
|---|---|
| `calendar_oauth.ts` | Builds Google/Outlook OAuth URLs and redirects to the consent screen |
| `calendar_oauth_callback.ts` | Exchanges the auth code for tokens, then creates a Recall calendar |
| `recall_webhook.ts` | **Core.** Handles `calendar.sync_events`, fetches changed events, and schedules/unschedules bots |
| `transcript_webhook.ts` | Receives finished transcripts; cleans, stores, and triggers KB ingestion |
| `calendar_events_list.ts` · `calendars_list.ts` · `calendars_delete.ts` | Proxy Recall's calendar/event endpoints for the dashboard |
| `bot_join.ts` · `bot_settings.ts` | Ad-hoc "join now" bots; workspace auto-join settings + catch-up scan |
| `knowledge_base.ts` · `knowledge_bases.ts` | KB documents, tags, chunking, embeddings, semantic search |
| `kb_ingest.ts` | Transcript → knowledge-base ingestion pipeline |
| `notes.ts` | Enriched meeting/notes list and detail (titles, participants) |
| `meeting_kb_override.ts` · `meeting_project.ts` | Per-meeting KB override and project assignment |
| `projects.ts` · `projectMembers.ts` · `invitations.ts` | Projects, membership/roles, and invite links |
| `voice_agent_config.ts` · `voice_agent_photo.ts` · `voice_agent_status.ts` | Voice-agent configuration, avatar upload, status |

## API Endpoints

All `/api/*` dashboard routes require a Clerk JWT (`Authorization: Bearer <token>`);
webhook and relay routes use their own auth (Recall signature / `x-api-key`).

| Method(s) | Endpoint | Description |
|---|---|---|
| GET | `/api/calendar/oauth` | Start OAuth (`?platform=google_calendar\|microsoft_outlook`) |
| GET | `/api/calendar/oauth/callback` | OAuth callback handler |
| POST | `/api/recall/webhook` | Recall.ai calendar webhook receiver |
| POST | `/api/webhooks/transcript` | Transcript webhook receiver |
| GET, DELETE | `/api/calendar` | List / disconnect calendars |
| GET | `/api/calendar/events` | List events for a calendar |
| POST, DELETE | `/api/calendar/events/bot` | Schedule / unschedule a bot for an event |
| GET, PUT | `/api/calendar/events/tag` | Get / set category tags for an event |
| POST | `/api/bot/join` | Create an ad-hoc bot for a meeting URL |
| GET, PATCH | `/api/bot-settings` | Read / update auto-join settings (PATCH runs a catch-up scan) |
| GET, POST, DELETE, PATCH | `/api/kb` | Knowledge-base documents (list/create/delete/toggle) |
| GET, POST · PATCH, DELETE | `/api/kb/tags`, `/api/kb/tags/:id` | Manage KB tags |
| POST, DELETE | `/api/kb/:docId/tags[/:tagId]` | Add / remove a tag on a document |
| GET | `/api/kb/transcripts` | User-scoped transcript list |
| POST | `/api/kb/retry/:botId` | Re-trigger KB ingestion for a meeting |
| GET, PUT, DELETE | `/api/kb/:id` | Single KB document |
| GET | `/api/knowledge-bases[/:slug]` | List / fetch published knowledge bases |
| GET, PATCH | `/api/notes`, `/api/notes/:botId` | Notes list, detail, and title update |
| GET | `/api/transcripts[/:botId]` | Raw transcripts |
| GET, PUT, DELETE | `/api/meeting-project` | Per-meeting → project assignment |
| GET, PUT, DELETE | `/api/meeting-kb/:calendarEventId` | Per-meeting KB override |
| GET, POST | `/api/projects`, `/api/projects/shared` | List / create projects; projects shared with caller |
| GET, PATCH, DELETE | `/api/projects/:id` | Project detail, update, delete |
| POST, DELETE | `/api/projects/:id/documents[/:docId]` | Add / remove project documents |
| POST | `/api/projects/:id/invite` | Generate an invite link (admin only) |
| GET, POST | `/api/invitations/:token[/accept]` | Resolve / accept an invite |
| GET | `/api/projects/:id/members` | List project members |
| PATCH, DELETE | `/api/projects/:id/members/:email` | Change role (admin) / remove member |
| POST | `/api/projects/:id/leave` | Leave a project |
| GET, PATCH | `/api/voice-agent-config[/photo]` · `/api/voice-agent/status` | Voice-agent config, avatar, status |
| GET, PUT | `/api/meetings/:botId/tags`, `/api/meetings/:botId/allowed-tags` | Per-meeting tags (relay uses `x-api-key`) |
| GET | `/api/relay/allowed-tags` | Resolve a meeting token → allowed tag IDs (relay) |

## Database

Postgres is managed by Supabase. Schema changes live in `supabase/migrations/` as
numbered SQL files (with matching `rollbacks/`). Knowledge-base search is powered by a
Postgres RPC over `pgvector` embeddings, with tag- and sharing-based filtering applied
server-side (`src/api/helpers/sharingFilter.ts`).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the branch strategy (`feature/*` → `develop`
→ `main`), commit conventions, PR process, CI pipeline, and the optional `graphify`
knowledge-graph tooling.
