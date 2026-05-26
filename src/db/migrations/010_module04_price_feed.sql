-- Module 04: Price Feed
-- Introduces price_providers, provider_routing, per-type price cache tables,
-- and the price_fetch_queue. Replaces asset_prices (generic) with type-specific
-- tables. Adds data_type to assets, retires collector_name.

-- Price fetch queue status ENUM
CREATE TYPE price_fetch_status AS ENUM ('pending', 'in_progress', 'done', 'failed');

-- Provider registry
CREATE TABLE price_providers (
  id                 UUID      PRIMARY KEY DEFAULT gen_random_uuid(),
  name               VARCHAR   NOT NULL UNIQUE,
  api_key_enc        VARCHAR   NOT NULL DEFAULT '',
  api_key_iv         VARCHAR   NOT NULL DEFAULT '',
  base_url           VARCHAR,
  rate_limit_per_min INT       NOT NULL DEFAULT 8,
  is_active          BOOLEAN   NOT NULL DEFAULT true,
  created_at         TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Routing rules: maps data_type (+ optional symbol override) to a provider
-- Resolution: symbol-level rule beats NULL (type-level) rule
CREATE TABLE provider_routing (
  id          UUID      PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id UUID      NOT NULL REFERENCES price_providers(id),
  data_type   VARCHAR   NOT NULL,
  symbol      VARCHAR,
  is_active   BOOLEAN   NOT NULL DEFAULT true,
  created_at  TIMESTAMP NOT NULL DEFAULT NOW()
);
-- One broad rule per data_type (symbol IS NULL)
CREATE UNIQUE INDEX provider_routing_type_broad  ON provider_routing (data_type) WHERE symbol IS NULL;
-- One symbol-level override per (data_type, symbol)
CREATE UNIQUE INDEX provider_routing_type_symbol ON provider_routing (data_type, symbol) WHERE symbol IS NOT NULL;

-- Per-type price cache tables
CREATE TABLE equity_india_prices (
  id               UUID      PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id         UUID      NOT NULL REFERENCES assets(id),
  price            NUMERIC(38,18) NOT NULL,
  recorded_at      TIMESTAMP NOT NULL DEFAULT NOW(),
  last_consumed_at TIMESTAMP
);
CREATE INDEX ON equity_india_prices (asset_id, recorded_at DESC);

CREATE TABLE equity_us_prices (
  id               UUID      PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id         UUID      NOT NULL REFERENCES assets(id),
  price            NUMERIC(38,18) NOT NULL,
  recorded_at      TIMESTAMP NOT NULL DEFAULT NOW(),
  last_consumed_at TIMESTAMP
);
CREATE INDEX ON equity_us_prices (asset_id, recorded_at DESC);

CREATE TABLE crypto_prices (
  id               UUID      PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id         UUID      NOT NULL REFERENCES assets(id),
  price            NUMERIC(38,18) NOT NULL,
  recorded_at      TIMESTAMP NOT NULL DEFAULT NOW(),
  last_consumed_at TIMESTAMP
);
CREATE INDEX ON crypto_prices (asset_id, recorded_at DESC);

CREATE TABLE mutual_fund_prices (
  id               UUID      PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id         UUID      NOT NULL REFERENCES assets(id),
  price            NUMERIC(38,18) NOT NULL,
  recorded_at      TIMESTAMP NOT NULL DEFAULT NOW(),
  last_consumed_at TIMESTAMP
);
CREATE INDEX ON mutual_fund_prices (asset_id, recorded_at DESC);

-- Drop the generic asset_prices table from Module 03 (superseded by per-type tables)
DROP TABLE asset_prices;

-- Price fetch queue
CREATE TABLE price_fetch_queue (
  id           UUID              PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id     UUID              NOT NULL REFERENCES assets(id),
  status       price_fetch_status NOT NULL DEFAULT 'pending',
  priority     INT               NOT NULL DEFAULT 2,
  retry_count  INT               NOT NULL DEFAULT 0,
  queued_at    TIMESTAMP         NOT NULL DEFAULT NOW(),
  started_at   TIMESTAMP,
  completed_at TIMESTAMP,
  error        TEXT
);
-- Prevent duplicate queue entries for the same asset while it is pending or in_progress
CREATE UNIQUE INDEX price_fetch_queue_active ON price_fetch_queue (asset_id)
  WHERE status IN ('pending', 'in_progress');

-- Add data_type to assets (replaces collector_name for api-mode assets)
ALTER TABLE assets ADD COLUMN data_type VARCHAR;

-- Drop collector_name (FK to data_collectors, retired for price feeds)
ALTER TABLE assets DROP COLUMN collector_name;

-- Seed: Twelve Data as the initial provider (key populated by syncProviders on boot)
INSERT INTO price_providers (name, base_url, rate_limit_per_min)
VALUES ('twelve-data', 'https://api.twelvedata.com', 8);

-- Seed: broad routing rules for all supported data types -> twelve-data
INSERT INTO provider_routing (provider_id, data_type, symbol)
SELECT id, unnested.data_type, NULL
FROM price_providers,
  (VALUES ('equity_india'), ('equity_us'), ('crypto'), ('mutual_fund')) AS unnested(data_type)
WHERE price_providers.name = 'twelve-data';
