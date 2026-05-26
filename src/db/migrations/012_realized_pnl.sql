-- Add cost_basis_minor to lots for sell rows.
-- Populated at sell time during FIFO walk: sum of (qty_consumed * buy_price_per_unit) across matched buy lots.
-- NULL on buy rows. Used to compute realized P&L = sell_proceeds_minor - cost_basis_minor.
ALTER TABLE lots ADD COLUMN cost_basis_minor NUMERIC(38,0);
