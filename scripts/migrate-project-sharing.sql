BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- LIG-53: project_members + project_invitations tables
-- ─────────────────────────────────────────────────────────────────────────────

-- ─── project_members ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS project_members (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid        NOT NULL REFERENCES kb_projects(id) ON DELETE CASCADE,
  user_email  text        NOT NULL,
  role        text        NOT NULL DEFAULT 'member',
  invited_by  text        NOT NULL,
  joined_at   timestamptz DEFAULT now(),
  UNIQUE (project_id, user_email)
);

-- ─── project_invitations ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS project_invitations (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id     uuid        NOT NULL REFERENCES kb_projects(id) ON DELETE CASCADE,
  invite_token   uuid        UNIQUE NOT NULL DEFAULT gen_random_uuid(),
  invited_email  text,
  invited_by     text        NOT NULL,
  status         text        NOT NULL DEFAULT 'pending',
  expires_at     timestamptz DEFAULT now() + interval '7 days',
  created_at     timestamptz DEFAULT now()
);

-- ─── Backfill existing owners ─────────────────────────────────────────────────
INSERT INTO project_members (project_id, user_email, role, invited_by)
SELECT id, user_id, 'owner', user_id
FROM kb_projects
ON CONFLICT (project_id, user_email) DO NOTHING;

-- ─── Indexes ──────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_project_members_user_email
  ON project_members(user_email);

CREATE INDEX IF NOT EXISTS idx_project_invitations_invite_token
  ON project_invitations(invite_token);

COMMIT;
