-- Ensure transcripts category exists
INSERT INTO kb_categories (name) VALUES ('transcripts') ON CONFLICT (name) DO NOTHING;

-- Update search_knowledge_base RPC to support date filtering
CREATE OR REPLACE FUNCTION search_knowledge_base(
  query_embedding vector(1536),
  match_threshold float DEFAULT 0.0,
  match_count int DEFAULT 5,
  filter_category text DEFAULT NULL,
  filter_date_from timestamptz DEFAULT NULL,
  filter_date_to timestamptz DEFAULT NULL
)
RETURNS TABLE (
  id uuid,
  document_id uuid,
  document_title text,
  category_name text,
  content text,
  similarity float
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
    c.content,
    1 - (c.embedding <=> query_embedding) AS similarity
  FROM kb_chunks c
  JOIN kb_documents d ON d.id = c.document_id
  JOIN kb_categories cat ON cat.id = d.category_id
  WHERE d.is_active = true
    AND (filter_category IS NULL OR cat.name = filter_category)
    AND (filter_date_from IS NULL OR d.created_at >= filter_date_from)
    AND (filter_date_to IS NULL OR d.created_at <= filter_date_to)
    AND 1 - (c.embedding <=> query_embedding) > match_threshold
  ORDER BY similarity DESC
  LIMIT match_count;
END;
$$;
