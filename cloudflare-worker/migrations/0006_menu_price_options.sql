-- Store configurable named price options for menu items (e.g. Coke: Bote, Mismo, Kasalo, 1.5L).
ALTER TABLE menu_items ADD COLUMN variants_json TEXT NOT NULL DEFAULT '[]';
