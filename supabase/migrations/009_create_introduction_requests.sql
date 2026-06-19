-- Introduction requests for brokered surfacing (LIG-71)
CREATE TABLE IF NOT EXISTS introduction_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  requester_email text NOT NULL,
  contributor_email text NOT NULL,
  project_id uuid REFERENCES kb_projects(id) ON DELETE CASCADE,
  kb_chunk_id uuid,
  query_text text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Index for looking up pending requests
CREATE INDEX IF NOT EXISTS idx_introduction_requests_status ON introduction_requests(status) WHERE status = 'pending';

-- Index for contributor notifications
CREATE INDEX IF NOT EXISTS idx_introduction_requests_contributor ON introduction_requests(contributor_email);

NOTIFY pgrst, 'reload schema';
