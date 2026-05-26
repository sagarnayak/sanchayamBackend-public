-- Module 09: Historical prices, corporate actions, asset symbol/name history

-- asset_aliases: full symbol and name history per asset
-- from_date/to_date defines the date range the symbol was active
-- to_date = null means currently active
CREATE TABLE asset_aliases (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id    UUID NOT NULL REFERENCES assets(id),
  symbol      VARCHAR NOT NULL,
  name        VARCHAR NOT NULL,
  from_date   DATE NOT NULL,
  to_date     DATE NULL,
  created_at  TIMESTAMP NOT NULL DEFAULT now()
);

CREATE INDEX asset_aliases_asset_id_idx ON asset_aliases(asset_id);
CREATE INDEX asset_aliases_date_range_idx ON asset_aliases(asset_id, from_date, to_date);

-- Seed current symbol/name for all existing assets as the active alias
INSERT INTO asset_aliases (asset_id, symbol, name, from_date, to_date)
SELECT id, symbol, name, '2000-01-01', NULL
FROM assets
WHERE symbol IS NOT NULL AND is_deleted = false;

-- corporate_actions: splits, bonuses, mergers, delistings per asset
-- ratio_from/ratio_to: for split/bonus, e.g. ratio_from=1, ratio_to=2 means 2-for-1 split
-- merged_into_asset_id: for mergers, points to the asset this one was absorbed into
CREATE TABLE corporate_actions (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id              UUID NOT NULL REFERENCES assets(id),
  action_type           VARCHAR NOT NULL CHECK (action_type IN ('split', 'bonus', 'merger', 'delisting')),
  action_date           DATE NOT NULL,
  ratio_from            NUMERIC NULL,
  ratio_to              NUMERIC NULL,
  merged_into_asset_id  UUID NULL REFERENCES assets(id),
  notes                 TEXT NULL,
  created_at            TIMESTAMP NOT NULL DEFAULT now()
);

CREATE INDEX corporate_actions_asset_id_idx ON corporate_actions(asset_id);
CREATE INDEX corporate_actions_asset_date_idx ON corporate_actions(asset_id, action_date);

-- asset_price_history: unified historical price store replacing the four per-type tables
-- price_date is the market date the price corresponds to (not when we fetched it)
-- source: 'api' = fetched from collector, 'agent' = LLM web search, 'import' = manual/script
CREATE TABLE asset_price_history (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id     UUID NOT NULL REFERENCES assets(id),
  price_date   DATE NOT NULL,
  price        NUMERIC(38,0) NOT NULL,
  recorded_at  TIMESTAMP NOT NULL DEFAULT now(),
  source       VARCHAR NOT NULL DEFAULT 'api' CHECK (source IN ('api', 'agent', 'import')),
  UNIQUE (asset_id, price_date)
);

CREATE INDEX asset_price_history_asset_date_idx ON asset_price_history(asset_id, price_date DESC);
