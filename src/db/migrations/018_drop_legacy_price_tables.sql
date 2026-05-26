-- Legacy per-type price tables replaced by asset_price_history (migration 017).
-- All data migrated. All code updated. Safe to drop.
DROP TABLE IF EXISTS equity_india_prices;
DROP TABLE IF EXISTS equity_us_prices;
DROP TABLE IF EXISTS mutual_fund_india_prices;
DROP TABLE IF EXISTS crypto_prices;
