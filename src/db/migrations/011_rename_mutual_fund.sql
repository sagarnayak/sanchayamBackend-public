-- Rename mutual_fund -> mutual_fund_india to be consistent with equity_india / equity_us
ALTER TABLE mutual_fund_prices RENAME TO mutual_fund_india_prices;

UPDATE provider_routing SET data_type = 'mutual_fund_india' WHERE data_type = 'mutual_fund';
