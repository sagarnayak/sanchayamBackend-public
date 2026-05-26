-- Remove duplicate rows from corporate_actions, keeping the earliest inserted row per unique event.
-- Duplicates accumulated because ON CONFLICT DO NOTHING had no constraint to match against.
DELETE FROM corporate_actions
WHERE id NOT IN (
  SELECT DISTINCT ON (asset_id, action_type, action_date, ratio_from, ratio_to) id
  FROM corporate_actions
  ORDER BY asset_id, action_type, action_date, ratio_from, ratio_to, created_at ASC
);

-- Unique constraint so ON CONFLICT DO NOTHING works correctly going forward.
ALTER TABLE corporate_actions
  ADD CONSTRAINT corporate_actions_unique
  UNIQUE (asset_id, action_type, action_date, ratio_from, ratio_to);

-- Remove duplicate rows from asset_aliases, keeping the earliest inserted row per unique alias.
DELETE FROM asset_aliases
WHERE id NOT IN (
  SELECT DISTINCT ON (asset_id, symbol, from_date) id
  FROM asset_aliases
  ORDER BY asset_id, symbol, from_date, created_at ASC
);

-- Unique constraint so ON CONFLICT DO NOTHING works correctly going forward.
ALTER TABLE asset_aliases
  ADD CONSTRAINT asset_aliases_unique
  UNIQUE (asset_id, symbol, from_date);
