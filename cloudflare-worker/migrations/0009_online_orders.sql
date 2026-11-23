-- Track customer orders separately from POS sales.
ALTER TABLE orders ADD COLUMN source TEXT NOT NULL DEFAULT 'pos';
ALTER TABLE orders ADD COLUMN customer_name TEXT;
ALTER TABLE orders ADD COLUMN customer_phone TEXT;
ALTER TABLE orders ADD COLUMN fulfillment_type TEXT;
ALTER TABLE orders ADD COLUMN delivery_address TEXT;
ALTER TABLE orders ADD COLUMN delivery_contact_requested INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_orders_source_status
ON orders(source, status);
