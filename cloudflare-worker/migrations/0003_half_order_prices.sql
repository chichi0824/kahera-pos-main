-- Add an optional administrator-configured half-order price (centavos).
-- Existing menu items remain full-order only until a half price is set.
ALTER TABLE menu_items ADD COLUMN half_price INTEGER;
