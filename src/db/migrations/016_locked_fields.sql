-- locked_unit_cost: if set, price per unit is fixed and hidden in the add form (e.g. bank_balance = 1)
-- locked_unit_quantity: if set, quantity is fixed and hidden in the add form (e.g. always 1)
ALTER TABLE assets
  ADD COLUMN locked_unit_cost     NUMERIC,
  ADD COLUMN locked_unit_quantity NUMERIC;

-- bank_balance: 1 unit = 1 currency unit, price is always 1
UPDATE assets SET locked_unit_cost = 1 WHERE data_type = 'bank_balance';
