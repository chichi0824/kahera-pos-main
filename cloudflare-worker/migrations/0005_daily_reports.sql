-- Daily report date and closure metadata.
ALTER TABLE shifts ADD COLUMN report_date TEXT;
ALTER TABLE shifts ADD COLUMN close_reason TEXT;

-- Backfill historical reports using Philippine local date (UTC + 8 hours).
UPDATE shifts
SET report_date = strftime('%Y-%m-%d', started_at, '+8 hours')
WHERE report_date IS NULL;
