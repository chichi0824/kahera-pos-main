-- D1 shared menu seed and globally unique order numbers.
-- Demo orders in menu-sample.js are deliberately NOT imported as real sales.
CREATE TABLE IF NOT EXISTS order_counters (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  value INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO order_counters (id, value) VALUES (1, 0);

-- One active business shift is shared by all cashier devices.
CREATE UNIQUE INDEX IF NOT EXISTS idx_shifts_one_open
ON shifts(status) WHERE status = 'open';

INSERT OR IGNORE INTO store_settings (id, settings_json)
VALUES (1, '{"bizName":"Kapehan sa Lantaw","bizNote":"Sample café · Valencia City, Bukidnon","vatRegistered":true}');

INSERT OR IGNORE INTO menu_categories (id, name, sort_order) VALUES
('drinks', 'Drinks', 0),
('meals', 'Rice meals', 1),
('merienda', 'Merienda', 2),
('extras', 'Extras', 3);

INSERT OR IGNORE INTO menu_items (id, category_id, name, price, available, sort_order)
VALUES ('m15', 'extras', 'Fried Egg', 1800, 1, 0);
