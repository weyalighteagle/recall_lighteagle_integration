-- Add user-editable meeting title column.
-- Nullable, no default, no backfill — existing rows fall back to the
-- calendar-API-derived title (event.raw.summary/subject) until a user renames them.
-- Resolution order at read time: meeting_title (DB) ?? calendarTitle (Recall API) ?? null.
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS meeting_title TEXT;
