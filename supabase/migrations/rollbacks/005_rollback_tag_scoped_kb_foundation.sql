-- ─────────────────────────────────────────────────────────────────────────────
-- Rollback for 005_tag_scoped_kb_foundation.sql
-- Run this ONLY if you need to undo Phase 1.
-- Drops tables in reverse dependency order, then removes added columns/indexes.
-- ─────────────────────────────────────────────────────────────────────────────

-- Drop new tables (reverse dependency order)
DROP TABLE IF EXISTS user_settings;
DROP TABLE IF EXISTS kb_ingestion_log;
DROP TABLE IF EXISTS meeting_tags;
DROP TABLE IF EXISTS kb_document_tags;
DROP TABLE IF EXISTS kb_tags;
DROP TABLE IF EXISTS orgs;

-- Remove added columns from existing tables
ALTER TABLE kb_chunks    DROP COLUMN IF EXISTS is_active;
ALTER TABLE kb_chunks    DROP COLUMN IF EXISTS tag_ids;
ALTER TABLE kb_chunks    DROP COLUMN IF EXISTS org_id;
ALTER TABLE kb_documents DROP COLUMN IF EXISTS org_id;
ALTER TABLE meetings     DROP COLUMN IF EXISTS org_id;

-- Drop indexes added by this migration (columns are gone, but belt-and-suspenders)
DROP INDEX IF EXISTS kb_chunks_embedding_hnsw;
DROP INDEX IF EXISTS kb_chunks_tag_ids_gin;
DROP INDEX IF EXISTS kb_chunks_org_id_idx;
DROP INDEX IF EXISTS kb_documents_org_id_idx;
DROP INDEX IF EXISTS meetings_org_id_idx;
