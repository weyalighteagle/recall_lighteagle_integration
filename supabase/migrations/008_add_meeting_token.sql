-- Add meeting_token column to meetings table.
-- This token is pre-generated before the Recall.ai bot creation call so it
-- can be embedded in the camera page URL at creation time (bot_id is not yet
-- known then). The relay reads it from the WebSocket URL query param and
-- resolves it to allowed tag IDs via GET /api/relay/allowed-tags?token=...

ALTER TABLE meetings ADD COLUMN IF NOT EXISTS meeting_token text;

CREATE UNIQUE INDEX IF NOT EXISTS idx_meetings_meeting_token
  ON meetings (meeting_token)
  WHERE meeting_token IS NOT NULL;
