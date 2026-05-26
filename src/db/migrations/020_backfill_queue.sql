-- Backfill queue: tracks the three-stage historical data pipeline per asset
-- Stages run in strict sequence: symbols -> splits -> prices
-- Watcher cron finds eligible assets and enqueues. Worker executes one item at a time.

CREATE TYPE backfill_stage AS ENUM ('symbols', 'splits', 'prices');
CREATE TYPE backfill_status AS ENUM ('pending', 'in_progress', 'done', 'failed');

CREATE TABLE backfill_queue (
  id              UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id        UUID          NOT NULL REFERENCES assets(id),
  stage           backfill_stage NOT NULL,
  status          backfill_status NOT NULL DEFAULT 'pending',
  priority        INT           NOT NULL DEFAULT 2,
  retry_count     INT           NOT NULL DEFAULT 0,
  last_checked_at TIMESTAMP     NULL,       -- when this stage last completed successfully
  queued_at       TIMESTAMP     NOT NULL DEFAULT NOW(),
  started_at      TIMESTAMP     NULL,
  completed_at    TIMESTAMP     NULL,
  error           TEXT          NULL
);

-- One active entry per (asset_id, stage) - prevents duplicate pending/in_progress entries
CREATE UNIQUE INDEX backfill_queue_active_idx
  ON backfill_queue (asset_id, stage)
  WHERE status IN ('pending', 'in_progress');

-- Fast lookup by status + priority for worker
CREATE INDEX backfill_queue_status_idx ON backfill_queue (status, priority, queued_at);

-- Fast lookup by asset for watcher eligibility checks
CREATE INDEX backfill_queue_asset_idx ON backfill_queue (asset_id, stage);
