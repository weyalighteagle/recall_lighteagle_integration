-- Fix: use meetingDate from document metadata for date filtering instead of created_at.
-- Transcripts store the actual meeting date in metadata->>'meetingDate'; created_at is
-- just the row insertion time and can be hours/days later than the meeting itself.

DROP FUNCTION IF EXISTS search_knowledge_base(vector, float, int, text, timestamptz, timestamptz, text);
DROP FUNCTION IF EXISTS search_knowledge_base(vector, float, int, text, timestamptz, timestamptz, text, uuid);
DROP FUNCTION IF EXISTS search_knowledge_base(vector, float, int, text, timestamptz, timestamptz, text, uuid, uuid[]);

CREATE OR REPLACE FUNCTION search_knowledge_base(
  query_embedding vector(1536),
  match_threshold float DEFAULT 0.3,
  match_count int DEFAULT 5,
  filter_category text DEFAULT NULL,
  filter_date_from timestamptz DEFAULT NULL,
  filter_date_to timestamptz DEFAULT NULL,
  filter_meeting_type text DEFAULT NULL,
  p_org_id uuid DEFAULT NULL,
  p_allowed_tag_ids uuid[] DEFAULT NULL
)
RETURNS TABLE (
  id uuid,
  content text,
  document_id uuid,
  document_title text,
  category_name text,
  source_type text,
  similarity float,
  document_date timestamptz
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    c.id,
    c.content,
    c.document_id,
    d.title AS document_title,
    cat.name AS category_name,
    d.source_type,
    1 - (c.embedding <=> query_embedding) AS similarity,
    COALESCE((d.metadata->>'meetingDate')::timestamptz, d.created_at) AS document_date
  FROM kb_chunks c
  JOIN kb_documents d ON d.id = c.document_id
  LEFT JOIN kb_categories cat ON cat.id = d.category_id
  WHERE
    c.is_active = true
    AND d.is_active = true
    AND 1 - (c.embedding <=> query_embedding) >= match_threshold
    AND (filter_category IS NULL OR cat.slug = filter_category)
    AND (filter_date_from IS NULL OR COALESCE((d.metadata->>'meetingDate')::timestamptz, d.created_at) >= filter_date_from)
    AND (filter_date_to IS NULL OR COALESCE((d.metadata->>'meetingDate')::timestamptz, d.created_at) <= filter_date_to)
    AND (filter_meeting_type IS NULL OR d.metadata->>'meeting_type' = filter_meeting_type)
    AND (p_org_id IS NULL OR c.org_id = p_org_id)
    AND (p_allowed_tag_ids IS NULL OR c.tag_ids && p_allowed_tag_ids)
  ORDER BY similarity DESC
  LIMIT match_count;
END;
$$;

NOTIFY pgrst, 'reload schema';
