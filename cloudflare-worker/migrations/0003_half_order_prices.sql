-- Add an optional administrator-configured half-order price (centavos).
-- Existing menu items remain full-order only until a half price is set.
ALTER TABLE menu_items ADD COLUMN half_price INTEGER;

-- Record the portion on normalized order item rows as well as the order payload.
ALTER TABLE order_items ADD COLUMN portion TEXT NOT NULL DEFAULT 'full';
