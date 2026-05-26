-- ENUMs
CREATE TYPE asset_unit_type AS ENUM ('whole', 'fractional', 'single');
CREATE TYPE asset_update_mode AS ENUM ('manual', 'api');
CREATE TYPE asset_update_frequency AS ENUM ('as_required', 'hourly', 'daily', 'weekly');
CREATE TYPE asset_cost_basis_mode AS ENUM ('fixed', 'floating');
CREATE TYPE holding_status AS ENUM ('active', 'exited', 'archived');
CREATE TYPE lot_transaction_type AS ENUM ('buy', 'sell');

-- Asset catalog (admin-managed)
CREATE TABLE assets (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name               VARCHAR NOT NULL UNIQUE,
  currency           VARCHAR(10) NOT NULL REFERENCES currencies(code),
  unit_type          asset_unit_type NOT NULL,
  update_mode        asset_update_mode NOT NULL,
  update_frequency   asset_update_frequency NOT NULL DEFAULT 'as_required',
  collector_name     VARCHAR REFERENCES data_collectors(name),
  symbol             VARCHAR,
  cost_basis_mode    asset_cost_basis_mode NOT NULL,
  is_active          BOOLEAN NOT NULL DEFAULT true,
  is_deleted         BOOLEAN NOT NULL DEFAULT false,
  deleted_at         TIMESTAMP,
  created_at         TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Shared price history for api-mode assets
CREATE TABLE asset_prices (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id    UUID NOT NULL REFERENCES assets(id),
  price       NUMERIC(38,18) NOT NULL,
  recorded_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_asset_prices_asset_recorded ON asset_prices(asset_id, recorded_at DESC);

-- User holdings (one per user per asset)
CREATE TABLE holdings (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id),
  asset_id    UUID NOT NULL REFERENCES assets(id),
  custom_name VARCHAR,
  unit_label  VARCHAR,
  status      holding_status NOT NULL DEFAULT 'active',
  tags        JSONB NOT NULL DEFAULT '[]',
  remarks     TEXT,
  is_deleted  BOOLEAN NOT NULL DEFAULT false,
  deleted_at  TIMESTAMP,
  created_at  TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, asset_id)
);

-- Buy/sell lots (fixed cost_basis_mode assets only)
CREATE TABLE lots (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  holding_id         UUID NOT NULL REFERENCES holdings(id),
  transaction_type   lot_transaction_type NOT NULL,
  quantity           NUMERIC(38,8) NOT NULL,
  remaining_quantity NUMERIC(38,8),
  price_per_unit     NUMERIC(38,0) NOT NULL,
  transaction_date   DATE NOT NULL,
  notes              TEXT,
  is_deleted         BOOLEAN NOT NULL DEFAULT false,
  deleted_at         TIMESTAMP,
  created_at         TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_lots_holding ON lots(holding_id, transaction_date ASC);

-- Manual value updates (floating assets and manual-mode fixed assets)
CREATE TABLE holding_values (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  holding_id  UUID NOT NULL REFERENCES holdings(id),
  value       NUMERIC(38,0) NOT NULL,
  recorded_at TIMESTAMP NOT NULL DEFAULT NOW(),
  notes       TEXT,
  created_at  TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_holding_values_holding_recorded ON holding_values(holding_id, recorded_at DESC);
