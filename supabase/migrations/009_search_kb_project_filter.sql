-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 009: Replace tag/category filter with project-scoped filter
--
-- Changes:
--   1. Create kb_projects, kb_document_projects, meeting_projects tables
--      (IF NOT EXISTS — safe to re-run if they were created manually).
--   2. Drop ALL existing overloads of search_knowledge_base.
--      PostgREST matches by parameter names; old signatures with
--      filter_category / p_allowed_tag_ids cause PGRST202 when the relay
--      sends filter_project_id.
--   3. Create new search_knowledge_base with filter_project_id (uuid).
--      Also renames return column document_date → meeting_date to match
--      what the relay's formatKBResults already reads.
-- ─────────────────────────────────────────────────────────────────────────────


-- ─── Section A: Project tables (IF NOT EXISTS guards) ────────────────────────

CREATE TABLE IF NOT EXISTS kb_projects (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     text        NOT NULL,
  name        text        NOT NULL,
  description text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS kb_projects_user_id_idx ON kb_projects(user_id);

CREATE TABLE IF NOT EXISTS kb_document_projects (
  document_id uuid        NOT NULL REFERENCES kb_documents(id) ON DELETE CASCADE,
  project_id  uuid        NOT NULL REFERENCES kb_projects(id)  ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (document_id, project_id)
);

CREATE INDEX IF NOT EXISTS kb_document_projects_project_id_idx ON kb_document_projects(project_id);

CREATE TABLE IF NOT EXISTS meeting_projects (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id        uuid        NOT NULL REFERENCES kb_projects(id) ON DELETE CASCADE,
  bot_id            text        UNIQUE,
  calendar_event_id text,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS meeting_projects_project_id_idx ON meeting_projects(project_id);
CREATE INDEX IF NOT EXISTS meeting_projects_bot_id_idx     ON meeting_projects(bot_id);


-- ─── Section B: Drop ALL existing search_knowledge_base overloads ────────────
-- Every overload must be listed by its exact argument types.
-- Migrations 001–007 created these variants:

DROP FUNCTION IF EXISTS search_knowledge_base(vector, float, int, text);
DROP FUNCTION IF EXISTS search_knowledge_base(vector, float, int, text, timestamptz, timestamptz);
DROP FUNCTION IF EXISTS search_knowledge_base(vector, float, int, text, timestamptz, timestamptz, text);
DROP FUNCTION IF EXISTS search_knowledge_base(vector, float, int, text, timestamptz, timestamptz, text, uuid);
DROP FUNCTION IF EXISTS search_knowledge_base(vector, float, int, text, timestamptz, timestamptz, text, uuid, uuid[]);


-- ─── Section C: New function — filter_project_id replaces old tag params ─────

CREATE OR REPLACE FUNCTION search_knowledge_base(
  query_embedding     vector(1536),
  match_threshold     float       DEFAULT 0.5,
  match_count         int         DEFAULT 5,
  filter_project_id   uuid        DEFAULT NULL,
  filter_date_from    timestamptz DEFAULT NULL,
  filter_date_to      timestamptz DEFAULT NULL,
  filter_meeting_type text        DEFAULT NULL,
  p_org_id            uuid        DEFAULT NULL
)
RETURNS TABLE (
  id             uuid,
  content        text,
  document_id    uuid,
  document_title text,
  category_name  text,
  source_type    text,
  similarity     float,
  meeting_date   timestamptz   -- was document_date; relay reads r.meeting_date
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    c.id,
    c.content,
    c.document_id,
    d.title                                  AS document_title,
    cat.name                                 AS category_name,
    d.source_type,
    1 - (c.embedding <=> query_embedding)    AS similarity,
    d.created_at                             AS meeting_date
  FROM kb_chunks c
  JOIN kb_documents d ON d.id = c.document_id
  LEFT JOIN kb_categories cat ON cat.id = d.category_id
  WHERE
    c.is_active = true
    AND d.is_active = true
    AND 1 - (c.embedding <=> query_embedding) >= match_threshold
    AND (filter_project_id IS NULL OR EXISTS (
          SELECT 1
          FROM kb_document_projects dp
          WHERE dp.document_id = d.id
            AND dp.project_id  = filter_project_id
        ))
    AND (filter_date_from    IS NULL OR d.created_at              >= filter_date_from)
    AND (filter_date_to      IS NULL OR d.created_at              <= filter_date_to)
    AND (filter_meeting_type IS NULL OR d.metadata->>'meeting_type' = filter_meeting_type)
    AND (p_org_id            IS NULL OR c.org_id                  = p_org_id)
  ORDER BY similarity DESC
  LIMIT match_count;
END;
$$;

NOTIFY pgrst, 'reload schema';
