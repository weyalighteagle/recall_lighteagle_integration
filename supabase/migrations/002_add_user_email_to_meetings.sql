-- Add user_email column to meetings table for per-user access control on the Notes page.
-- Nullable for backward-compat with existing rows.
-- New rows are populated:
--   • calendar-scheduled bots: set in schedule_bot_for_calendar_event() when the bot is first pre-inserted
--   • ad-hoc bots: set in bot_join() from the authenticated user's Clerk email
-- Existing rows without user_email fall back to calendar event cross-reference at query time.
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS user_email TEXT;
CREATE INDEX IF NOT EXISTS idx_meetings_user_email ON meetings(user_email);
