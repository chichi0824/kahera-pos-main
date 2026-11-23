
-- Store settings
CREATE TABLE IF NOT EXISTS store_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    settings_json TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Menu categories
CREATE TABLE IF NOT EXISTS menu_categories (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0
);

-- Menu items
CREATE TABLE IF NOT EXISTS menu_items (
    id TEXT PRIMARY KEY,
    category_id TEXT NOT NULL,
    name TEXT NOT NULL,
    price INTEGER NOT NULL,
    available INTEGER NOT NULL DEFAULT 1,
    sort_order INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (category_id) REFERENCES menu_categories(id)
);

-- Cashier shifts
CREATE TABLE IF NOT EXISTS shifts (
    id TEXT PRIMARY KEY,
    device_id TEXT NOT NULL,
    cashier_name TEXT,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    opening_cash INTEGER NOT NULL DEFAULT 0,
    closing_cash INTEGER,
    notes TEXT,
    status TEXT NOT NULL DEFAULT 'open'
);

-- Completed orders
CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,
    order_no TEXT NOT NULL UNIQUE,
    shift_id TEXT,
    device_id TEXT NOT NULL,
    cashier_name TEXT,
    created_at TEXT NOT NULL,
    order_type TEXT NOT NULL,
    table_no TEXT,
    payment_method TEXT NOT NULL,
    payment_reference TEXT,
    tendered INTEGER NOT NULL DEFAULT 0,
    change_amount INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'paid',
    voided_at TEXT,
    totals_json TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    FOREIGN KEY (shift_id) REFERENCES shifts(id)
);

-- Individual items belonging to each order
CREATE TABLE IF NOT EXISTS order_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id TEXT NOT NULL,
    menu_item_id TEXT,
    item_name TEXT NOT NULL,
    unit_price INTEGER NOT NULL,
    quantity INTEGER NOT NULL,
    line_total INTEGER NOT NULL,
    FOREIGN KEY (order_id) REFERENCES orders(id)
);

CREATE INDEX IF NOT EXISTS idx_orders_created_at
ON orders(created_at);

CREATE INDEX IF NOT EXISTS idx_orders_shift_id
ON orders(shift_id);

CREATE INDEX IF NOT EXISTS idx_orders_status
ON orders(status);

CREATE INDEX IF NOT EXISTS idx_order_items_order_id
ON order_items(order_id);
