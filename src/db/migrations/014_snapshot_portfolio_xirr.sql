-- Add portfolio_xirr to portfolio_snapshots.
-- Computed at snapshot time by aggregating all fixed cost_basis_mode lots
-- across all holdings for the user, converted to base currency, with current
-- portfolio total value as the terminal cash flow.
ALTER TABLE portfolio_snapshots ADD COLUMN portfolio_xirr NUMERIC(10,6);
