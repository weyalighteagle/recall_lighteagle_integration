-- Drop old RPC overloads to avoid Supabase overload conflicts
DROP FUNCTION IF EXISTS search_knowledge_base(vector(1536), float, int, text, timestamptz, timestamptz);
DROP FUNCTION IF EXISTS search_knowledge_base(vector(1536), float, int, text, timestamptz, timestamptz, text);
DROP FUNCTION IF EXISTS search_knowledge_base(vector(1536), float, int, text, timestamptz, timestamptz, text, text);

CREATE OR REPLACE FUNCTION search_knowledge_base(
  query_embedding vector(1536),
  match_threshold float DEFAULT 0.0,
  match_count int DEFAULT 5,
  filter_category text DEFAULT NULL,
  filter_date_from timestamptz DEFAULT NULL,
  filter_date_to timestamptz DEFAULT NULL,
  filter_meeting_type text DEFAULT NULL
)
RETURNS TABLE (
  id uuid,
  document_id uuid,
  document_title text,
  category_name text,
  source_type text,
  content text,
  similarity float,
  meeting_date timestamptz
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    c.id,
    c.document_id,
    d.title AS document_title,
    cat.name AS category_name,
    d.source_type,
    c.content,
    1 - (c.embedding <=> query_embedding) AS similarity,
    d.created_at AS meeting_date
  FROM kb_chunks c
  JOIN kb_documents d ON d.id = c.document_id
  JOIN kb_categories cat ON cat.id = d.category_id
  WHERE d.is_active = true
    AND (filter_category IS NULL OR cat.name = filter_category)
    AND (filter_date_from IS NULL OR d.created_at >= filter_date_from)
    AND (filter_date_to IS NULL OR d.created_at <= filter_date_to)
    AND (filter_meeting_type IS NULL OR d.metadata->>'meeting_type' = filter_meeting_type)
    AND 1 - (c.embedding <=> query_embedding) > match_threshold
  ORDER BY similarity DESC
  LIMIT match_count;
END;
$$;
