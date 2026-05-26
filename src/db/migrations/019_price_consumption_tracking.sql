-- Track when each asset's price was last consumed (read by a user/route)
-- Used by the price refresh cron to skip assets nobody is looking at (48h unused = stop refreshing)
ALTER TABLE assets ADD COLUMN price_last_consumed_at TIMESTAMPTZ;
