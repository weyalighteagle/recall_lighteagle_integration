-- ─────────────────────────────────────────────────────────────────────────────
-- Phase 1: Tag-scoped KB data model foundation
-- Additive-only. No function changes. No RLS. No backfill beyond org_id seed.
-- ─────────────────────────────────────────────────────────────────────────────

-- ─── Section A: Extension ────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS vector;


-- ─── Section B: orgs table + seed ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS orgs (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text        NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO orgs (name) VALUES ('Light Eagle')
ON CONFLICT (name) DO NOTHING;


-- ─── Section C: kb_tags ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS kb_tags (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid        NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  name       text        NOT NULL,
  slug       text        NOT NULL,
  color      text,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, slug)
);

CREATE INDEX IF NOT EXISTS kb_tags_org_id_idx ON kb_tags(org_id);


-- ─── Section D: Join tables, ingestion log, user settings ────────────────────

-- kb_document_tags: links documents to tags
CREATE TABLE IF NOT EXISTS kb_document_tags (
  document_id uuid        NOT NULL REFERENCES kb_documents(id) ON DELETE CASCADE,
  tag_id      uuid        NOT NULL REFERENCES kb_tags(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (document_id, tag_id)
);

CREATE INDEX IF NOT EXISTS kb_document_tags_tag_id_idx ON kb_document_tags(tag_id);

-- meeting_tags: links meetings (by bot_id) to tags.
-- FK to meetings.bot_id is included because the column carries a UNIQUE constraint
-- (confirmed: supabase upsert onConflict:'bot_id' works in production, 0 duplicate
-- bot_ids found in 192 rows). ON DELETE CASCADE so tag links clean up if a meeting
-- row is deleted.
CREATE TABLE IF NOT EXISTS meeting_tags (
  bot_id     text        NOT NULL REFERENCES meetings(bot_id) ON DELETE CASCADE,
  tag_id     uuid        NOT NULL REFERENCES kb_tags(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (bot_id, tag_id)
);

CREATE INDEX IF NOT EXISTS meeting_tags_bot_id_idx ON meeting_tags(bot_id);
CREATE INDEX IF NOT EXISTS meeting_tags_tag_id_idx ON meeting_tags(tag_id);

-- kb_ingestion_log: one row per bot.done webhook, tracks ingest lifecycle.
-- 'skipped' covers legitimate no-ops (e.g. transcript too short, duplicate hash).
CREATE TABLE IF NOT EXISTS kb_ingestion_log (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  bot_id     text        NOT NULL,
  status     text        NOT NULL CHECK (status IN ('pending', 'success', 'failed', 'skipped')),
  chunk_count integer,
  error      text,
  note       text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS kb_ingestion_log_bot_id_idx ON kb_ingestion_log(bot_id);
CREATE INDEX IF NOT EXISTS kb_ingestion_log_status_idx ON kb_ingestion_log(status);
-- Partial index: cheap queue-scan for Phase 3's retry worker
CREATE INDEX IF NOT EXISTS kb_ingestion_log_status_created_idx
  ON kb_ingestion_log(status, created_at)
  WHERE status = 'pending';

-- user_settings: per-user KB preferences
CREATE TABLE IF NOT EXISTS user_settings (
  user_email       text        PRIMARY KEY,
  default_tag_ids  uuid[]      NOT NULL DEFAULT '{}',
  org_id           uuid        REFERENCES orgs(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS user_settings_org_id_idx ON user_settings(org_id);


-- ─── Section E: Nullable columns on existing tables ──────────────────────────

ALTER TABLE kb_documents ADD COLUMN IF NOT EXISTS org_id uuid REFERENCES orgs(id);
ALTER TABLE kb_chunks    ADD COLUMN IF NOT EXISTS org_id uuid REFERENCES orgs(id);
ALTER TABLE meetings     ADD COLUMN IF NOT EXISTS org_id uuid REFERENCES orgs(id);

-- Denormalized tag_ids on kb_chunks for fast tag-overlap filtering in the search RPC (Phase 5).
-- is_active mirrors the parent document's is_active so chunk queries don't need a JOIN to filter.
ALTER TABLE kb_chunks ADD COLUMN IF NOT EXISTS tag_ids   uuid[]  NOT NULL DEFAULT '{}';
ALTER TABLE kb_chunks ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true;

-- Standard b-tree indexes for org_id lookups
CREATE INDEX IF NOT EXISTS kb_documents_org_id_idx ON kb_documents(org_id);
CREATE INDEX IF NOT EXISTS kb_chunks_org_id_idx    ON kb_chunks(org_id);
CREATE INDEX IF NOT EXISTS meetings_org_id_idx     ON meetings(org_id);

-- GIN index for array-overlap filtering on tag_ids (Phase 5 RPC uses @> / ANY())
CREATE INDEX IF NOT EXISTS kb_chunks_tag_ids_gin ON kb_chunks USING GIN (tag_ids);

-- HNSW vector index on kb_chunks.embedding.
-- No prior vector index exists in any committed migration; adding here.
-- CREATE INDEX IF NOT EXISTS is safe if it was somehow added outside migrations.
CREATE INDEX IF NOT EXISTS kb_chunks_embedding_hnsw
  ON kb_chunks USING hnsw (embedding vector_cosine_ops);


-- ─── Section F: Backfill ─────────────────────────────────────────────────────
DO $$
DECLARE
  v_org_id                  uuid;
  v_kb_docs_updated         int;
  v_kb_chunks_updated       int;
  v_meetings_updated        int;
  v_inactive_chunks_updated int;
BEGIN
  SELECT id INTO v_org_id FROM orgs WHERE name = 'Light Eagle';
  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'Light Eagle org not found — Section B failed';
  END IF;

  UPDATE kb_documents SET org_id = v_org_id WHERE org_id IS NULL;
  GET DIAGNOSTICS v_kb_docs_updated = ROW_COUNT;

  UPDATE kb_chunks SET org_id = v_org_id WHERE org_id IS NULL;
  GET DIAGNOSTICS v_kb_chunks_updated = ROW_COUNT;

  UPDATE meetings SET org_id = v_org_id WHERE org_id IS NULL;
  GET DIAGNOSTICS v_meetings_updated = ROW_COUNT;

  -- Sync kb_chunks.is_active from parent document for any deactivated docs.
  -- Research confirmed 6 kb_documents have is_active=false; their chunks default
  -- to true from the ALTER TABLE above and need to be corrected here.
  UPDATE kb_chunks c SET is_active = false
  FROM kb_documents d
  WHERE c.document_id = d.id
    AND d.is_active = false
    AND c.is_active = true;
  GET DIAGNOSTICS v_inactive_chunks_updated = ROW_COUNT;

  RAISE NOTICE 'Backfill: kb_documents=%, kb_chunks=%, meetings=%, inactive_chunks=%',
    v_kb_docs_updated, v_kb_chunks_updated, v_meetings_updated, v_inactive_chunks_updated;
END $$;
