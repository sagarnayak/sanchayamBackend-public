-- Module 07: Family View
-- family_id on users, include_in_family on connections, family snapshot tables

ALTER TABLE users ADD COLUMN family_id UUID;
CREATE INDEX ON users(family_id) WHERE family_id IS NOT NULL;

ALTER TABLE family_connections ADD COLUMN include_in_family BOOLEAN NOT NULL DEFAULT true;

CREATE TABLE family_portfolio_snapshots (
  id             UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id      UUID         NOT NULL,
  snapshot_date  DATE         NOT NULL,
  source         VARCHAR(20)  NOT NULL DEFAULT 'cron',
  portfolio_xirr NUMERIC(10,6),
  created_at     TIMESTAMP    NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMP    NOT NULL DEFAULT NOW(),
  UNIQUE (family_id, snapshot_date)
);

CREATE TABLE family_portfolio_snapshot_entries (
  id                    UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_id           UUID         NOT NULL REFERENCES family_portfolio_snapshots(id) ON DELETE CASCADE,
  user_id               UUID         NOT NULL REFERENCES users(id),
  holding_id            UUID         NOT NULL,
  asset_id              UUID         NOT NULL,
  asset_name            VARCHAR      NOT NULL,
  asset_category        VARCHAR      NOT NULL,
  currency              VARCHAR(10)  NOT NULL,
  quantity              NUMERIC      NOT NULL,
  price_per_unit_minor  NUMERIC      NOT NULL,
  value_minor           NUMERIC      NOT NULL,
  xirr                  NUMERIC(10,6)
);

CREATE INDEX ON family_portfolio_snapshot_entries(snapshot_id);
CREATE INDEX ON family_portfolio_snapshot_entries(user_id);
