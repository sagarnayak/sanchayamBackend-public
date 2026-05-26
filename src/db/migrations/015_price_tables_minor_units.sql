-- Migrate price cache tables from major-unit NUMERIC(38,18) to minor-unit NUMERIC(38,0).
-- All price tables are empty at migration time; no data to convert.
-- Storage is now in minor currency units (paise for INR, cents for USD).
-- The prices service handles conversion at read/write; callers see major units via getLatestPrice().

ALTER TABLE equity_india_prices      ALTER COLUMN price TYPE NUMERIC(38,0) USING ROUND(price);
ALTER TABLE equity_us_prices         ALTER COLUMN price TYPE NUMERIC(38,0) USING ROUND(price);
ALTER TABLE crypto_prices            ALTER COLUMN price TYPE NUMERIC(38,0) USING ROUND(price);
ALTER TABLE mutual_fund_india_prices ALTER COLUMN price TYPE NUMERIC(38,0) USING ROUND(price);
