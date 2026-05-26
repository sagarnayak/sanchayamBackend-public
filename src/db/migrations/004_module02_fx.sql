-- Module 02: FX Service
-- fx_providers, currency_provider_map, fx_rates
-- Notification service: notification_events, notification_config

CREATE TABLE fx_providers (
  id           UUID      PRIMARY KEY DEFAULT gen_random_uuid(),
  name         VARCHAR   NOT NULL UNIQUE,
  api_key_enc  VARCHAR   NOT NULL DEFAULT '',
  api_key_iv   VARCHAR   NOT NULL DEFAULT '',
  base_url     VARCHAR,
  is_active    BOOLEAN   NOT NULL DEFAULT true,
  created_at   TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE currency_provider_map (
  currency_code VARCHAR(10) PRIMARY KEY REFERENCES currencies(code),
  provider_name VARCHAR     NOT NULL REFERENCES fx_providers(name)
);

CREATE TABLE fx_rates (
  currency_code  VARCHAR(10)    PRIMARY KEY REFERENCES currencies(code),
  rate_vs_pivot  NUMERIC(38,18) NOT NULL,
  provider_name  VARCHAR        NOT NULL,
  fetched_at     TIMESTAMP      NOT NULL
);

CREATE TYPE notification_status    AS ENUM ('pending', 'sent', 'failed');
CREATE TYPE notification_recipient AS ENUM ('master_admin');
CREATE TYPE notification_channel   AS ENUM ('email');

CREATE TABLE notification_events (
  id           UUID                NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  type         VARCHAR             NOT NULL,
  payload      JSONB               NOT NULL DEFAULT '{}',
  status       notification_status NOT NULL DEFAULT 'pending',
  retry_count  INT                 NOT NULL DEFAULT 0,
  created_at   TIMESTAMP           NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMP
);

CREATE TABLE notification_config (
  id                 UUID                   PRIMARY KEY DEFAULT gen_random_uuid(),
  notification_type  VARCHAR                NOT NULL UNIQUE,
  recipient_type     notification_recipient NOT NULL DEFAULT 'master_admin',
  channel            notification_channel   NOT NULL DEFAULT 'email',
  is_active          BOOLEAN                NOT NULL DEFAULT true,
  created_at         TIMESTAMP              NOT NULL DEFAULT NOW()
);

-- Twelve Data is the single provider for all market data
INSERT INTO fx_providers (name, base_url)
VALUES ('twelve-data', 'https://api.twelvedata.com');

-- Map all non-pivot (non-USD) currencies to twelve-data
-- USD is the pivot currency - its rate is always 1, never fetched
INSERT INTO currency_provider_map (currency_code, provider_name) VALUES
  ('INR',  'twelve-data'),
  ('EUR',  'twelve-data'),
  ('GBP',  'twelve-data'),
  ('AED',  'twelve-data'),
  ('SGD',  'twelve-data'),
  ('CAD',  'twelve-data'),
  ('AUD',  'twelve-data'),
  ('HKD',  'twelve-data'),
  ('JPY',  'twelve-data'),
  ('CHF',  'twelve-data'),
  ('SAR',  'twelve-data'),
  ('BTC',  'twelve-data'),
  ('ETH',  'twelve-data'),
  ('USDT', 'twelve-data');

-- System alert types - all route to master admin via email
INSERT INTO notification_config (notification_type) VALUES
  ('FX_RATE_UNAVAILABLE'),
  ('PROVIDER_CALL_FAILED'),
  ('PRICE_FETCH_FAILED');
