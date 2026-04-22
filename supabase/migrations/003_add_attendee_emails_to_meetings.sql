ALTER TABLE meetings
  ADD COLUMN IF NOT EXISTS attendee_emails TEXT[] NOT NULL DEFAULT '{}';

-- GIN index required for @> array containment operator on attendee_emails
CREATE INDEX IF NOT EXISTS idx_meetings_attendee_emails
  ON meetings USING GIN (attendee_emails);
