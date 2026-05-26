-- Unified data collector registry
-- Replaces fx_providers + currency_provider_map from migration 004

CREATE TABLE data_collectors (
  id                 UUID      PRIMARY KEY DEFAULT gen_random_uuid(),
  name               VARCHAR   NOT NULL UNIQUE,
  api_key_enc        VARCHAR   NOT NULL DEFAULT '',
  api_key_iv         VARCHAR   NOT NULL DEFAULT '',
  base_url           VARCHAR,
  rate_limit_per_min INT       NOT NULL DEFAULT 8,
  is_active          BOOLEAN   NOT NULL DEFAULT true,
  created_at         TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TYPE collector_data_type AS ENUM ('fx_rate', 'equity_price', 'mf_price', 'crypto_price');

CREATE TABLE collector_capabilities (
  id              UUID                 PRIMARY KEY DEFAULT gen_random_uuid(),
  collector_name  VARCHAR              NOT NULL REFERENCES data_collectors(name),
  data_type       collector_data_type  NOT NULL,
  exchange        VARCHAR,
  created_at      TIMESTAMP            NOT NULL DEFAULT NOW()
);

CREATE TABLE currency_collector_map (
  currency_code   VARCHAR(10) PRIMARY KEY REFERENCES currencies(code),
  collector_name  VARCHAR     NOT NULL REFERENCES data_collectors(name)
);

-- Migrate existing fx_providers row into data_collectors
INSERT INTO data_collectors (id, name, api_key_enc, api_key_iv, base_url, rate_limit_per_min, is_active, created_at)
SELECT id, name, api_key_enc, api_key_iv, base_url, 8, is_active, created_at
FROM fx_providers;

-- Migrate currency mappings
INSERT INTO currency_collector_map (currency_code, collector_name)
SELECT currency_code, provider_name FROM currency_provider_map;

-- Seed twelve-data capabilities
INSERT INTO collector_capabilities (collector_name, data_type, exchange) VALUES
  ('twelve-data', 'fx_rate',       NULL),
  ('twelve-data', 'equity_price',  'NSE'),
  ('twelve-data', 'equity_price',  'BSE'),
  ('twelve-data', 'equity_price',  'NASDAQ'),
  ('twelve-data', 'equity_price',  'NYSE'),
  ('twelve-data', 'mf_price',      NULL),
  ('twelve-data', 'crypto_price',  NULL);

-- Drop old tables (currency_provider_map first — it has FK to fx_providers)
DROP TABLE currency_provider_map;
DROP TABLE fx_providers;

-- Rename provider_name → collector_name in fx_rates
ALTER TABLE fx_rates RENAME COLUMN provider_name TO collector_name;
