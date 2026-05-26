-- Portfolio snapshot tables for Module 08 - Portfolio Analytics.
-- One snapshot per user per date. Entries are per-holding per snapshot.
-- Values stored in native asset currency; FX conversion happens at display time using current rates.
-- XIRR per holding computed and stored at snapshot time. Portfolio-level XIRR computed at display time.

CREATE TABLE portfolio_snapshots (
  id          UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id     UUID        NOT NULL REFERENCES users(id),
  snapshot_date DATE      NOT NULL,
  source      VARCHAR(20) NOT NULL DEFAULT 'cron', -- 'cron' | 'import'
  created_at  TIMESTAMP   NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, snapshot_date)
);

CREATE TABLE portfolio_snapshot_entries (
  id                  UUID          DEFAULT gen_random_uuid() PRIMARY KEY,
  snapshot_id         UUID          NOT NULL REFERENCES portfolio_snapshots(id) ON DELETE CASCADE,
  holding_id          UUID          NOT NULL REFERENCES holdings(id),
  asset_id            UUID          NOT NULL REFERENCES assets(id),
  asset_name          VARCHAR(255)  NOT NULL,
  asset_category      VARCHAR(100)  NOT NULL,
  currency            VARCHAR(10)   NOT NULL,
  quantity            NUMERIC(38,8) NOT NULL,
  price_per_unit_minor NUMERIC(38,0) NOT NULL,
  value_minor         NUMERIC(38,0) NOT NULL,
  xirr                NUMERIC(10,6),
  created_at          TIMESTAMP     NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_portfolio_snapshots_user_date ON portfolio_snapshots(user_id, snapshot_date DESC);
CREATE INDEX idx_portfolio_snapshot_entries_snapshot ON portfolio_snapshot_entries(snapshot_id);
CREATE INDEX idx_portfolio_snapshot_entries_holding ON portfolio_snapshot_entries(holding_id);
